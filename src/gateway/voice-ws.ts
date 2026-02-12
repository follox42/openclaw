/**
 * @module voice-ws
 * WebSocket voice endpoint for real-time speech interaction.
 *
 * Protocol:
 * - Client connects to `/voice/ws` with Bearer token auth
 * - Client sends binary frames: PCM16 mono 16kHz audio chunks
 * - Client sends JSON text frames for control: `config`, `end_of_speech`
 * - Server sends JSON text frames: `transcript`, `status`, `audio_start`, `audio_end`
 * - Server sends binary frames: PCM16 TTS audio chunks
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import { textToSpeechTelephony } from "../tts/tts.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken } from "./http-utils.js";
import { calculateRms, transcribeAudio, VAD_SILENCE_THRESHOLD } from "./voice-audio.js";

const VAD_SILENCE_MS = 800;
const VAD_MIN_SPEECH_MS = 300;
const MAX_AUDIO_BUFFER = 320_000;
const VOICE_WS_PATH = "/voice/ws";

type VoiceSession = {
  ws: WebSocket;
  audioChunks: Buffer[];
  totalBytes: number;
  lastAudioTime: number;
  isSpeaking: boolean;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  sessionKey: string;
  agentId: string;
};

/** Send a JSON message to the WebSocket client. */
function sendMsg(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

/** Process accumulated audio: STT → Agent → TTS → send back. */
async function processAudio(session: VoiceSession) {
  if (session.processing || session.audioChunks.length === 0) return;
  session.processing = true;

  const audioBuffer = Buffer.concat(session.audioChunks);
  session.audioChunks = [];
  session.totalBytes = 0;

  try {
    sendMsg(session.ws, { type: "status", status: "transcribing" });
    const transcript = await transcribeAudio(audioBuffer);
    if (!transcript) {
      sendMsg(session.ws, { type: "status", status: "no_speech" });
      return;
    }
    sendMsg(session.ws, { type: "transcript", text: transcript, role: "user" });

    sendMsg(session.ws, { type: "status", status: "thinking" });
    const runId = `voice_${randomUUID()}`;
    let responseText = "";

    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId !== runId || evt.stream !== "assistant") return;
      const delta = evt.data?.delta ?? evt.data?.text;
      if (typeof delta === "string" && delta) {
        responseText += delta;
        sendMsg(session.ws, { type: "assistant_delta", delta });
      }
    });

    try {
      const result = await agentCommand(
        {
          message: transcript,
          sessionKey: session.sessionKey,
          runId,
          deliver: false,
          messageChannel: "voice",
          bestEffortDeliver: false,
          agentId: session.agentId || undefined,
        },
        defaultRuntime,
        createDefaultDeps(),
      );
      if (!responseText) {
        const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
        responseText = Array.isArray(payloads)
          ? payloads
              .map((p) => p.text ?? "")
              .filter(Boolean)
              .join("\n\n")
          : "No response.";
      }
    } finally {
      unsubscribe();
    }

    sendMsg(session.ws, { type: "transcript", text: responseText, role: "assistant" });

    if (responseText.trim()) {
      sendMsg(session.ws, { type: "audio_start" });
      const cfg = loadConfig();
      const tts = await textToSpeechTelephony({ text: responseText, cfg });
      if (tts.success && tts.audioBuffer) {
        for (let i = 0; i < tts.audioBuffer.length; i += 4096) {
          if (session.ws.readyState !== session.ws.OPEN) break;
          session.ws.send(tts.audioBuffer.subarray(i, i + 4096));
        }
      }
      sendMsg(session.ws, {
        type: "audio_end",
        sampleRate: tts.sampleRate ?? 24000,
        format: "pcm16",
      });
    }
  } catch (err) {
    sendMsg(session.ws, { type: "error", message: String(err) });
  } finally {
    session.processing = false;
  }
}

/** Handle incoming audio with VAD-based silence detection. */
function handleAudioData(session: VoiceSession, data: Buffer) {
  if (session.processing) return;
  if (session.totalBytes + data.length > MAX_AUDIO_BUFFER) {
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
    void processAudio(session);
    return;
  }

  session.audioChunks.push(data);
  session.totalBytes += data.length;
  const rms = calculateRms(data);

  if (rms > VAD_SILENCE_THRESHOLD) {
    session.isSpeaking = true;
    session.lastAudioTime = Date.now();
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
  } else if (session.isSpeaking && !session.silenceTimer) {
    session.silenceTimer = setTimeout(() => {
      session.isSpeaking = false;
      session.silenceTimer = null;
      const durationMs = (session.totalBytes / 2 / 16000) * 1000;
      if (durationMs >= VAD_MIN_SPEECH_MS) {
        void processAudio(session);
      } else {
        session.audioChunks = [];
        session.totalBytes = 0;
      }
    }, VAD_SILENCE_MS);
  }
}

/** Create the voice WebSocket handler. Returns an upgrade handler to integrate with the HTTP server. */
export function createVoiceWss(opts: {
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies?: string[];
}): { handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean } {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    const session: VoiceSession = {
      ws,
      audioChunks: [],
      totalBytes: 0,
      lastAudioTime: Date.now(),
      isSpeaking: false,
      silenceTimer: null,
      processing: false,
      sessionKey: `voice:${randomUUID()}`,
      agentId: "main",
    };

    sendMsg(ws, {
      type: "connected",
      sessionKey: session.sessionKey,
      sampleRate: 16000,
      format: "pcm16_mono",
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        handleAudioData(session, data as Buffer);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === "config") {
          if (typeof msg.sessionKey === "string") session.sessionKey = msg.sessionKey;
          if (typeof msg.agentId === "string") session.agentId = msg.agentId;
          sendMsg(ws, { type: "config_ack" });
        } else if (msg.type === "end_of_speech") {
          if (session.silenceTimer) clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
          session.isSpeaking = false;
          void processAudio(session);
        }
      } catch {
        /* ignore malformed JSON */
      }
    });

    ws.on("close", () => {
      if (session.silenceTimer) clearTimeout(session.silenceTimer);
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== VOICE_WS_PATH) return false;

      void (async () => {
        try {
          const token = getBearerToken(req) ?? url.searchParams.get("token") ?? undefined;
          const authResult = await authorizeGatewayConnect({
            auth: opts.resolvedAuth,
            connectAuth: { token, password: token },
            req,
            trustedProxies: opts.trustedProxies ?? [],
          });
          if (!authResult.ok) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        } catch {
          socket.destroy();
        }
      })();
      return true;
    },
  };
}
