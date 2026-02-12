/**
 * @module telegram-voice/voice-bridge
 * Bridges Telegram P2P voice calls directly to the agent via STT → Agent → TTS.
 *
 * Audio flow:
 * 1. Telegram call established → callReady event from call-handler
 * 2. WebRTC audio from Telegram → PCM16 accumulation with VAD
 * 3. Speech detected → transcribeAudio (Groq Whisper) → text
 * 4. Text → agentCommand → response text
 * 5. Response → textToSpeechTelephony → PCM16 → WebRTC audio → Telegram
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { TelegramVoiceConfig } from "./config.js";
import type { VoiceBridgeEvent } from "./types.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import { agentCommand } from "../../../commands/agent.js";
import { loadConfig } from "../../../config/config.js";
import {
  calculateRms,
  transcribeAudio,
  VAD_SILENCE_THRESHOLD,
} from "../../../gateway/voice-audio.js";
import { defaultRuntime } from "../../../runtime.js";
import { textToSpeechTelephony } from "../../../tts/tts.js";
import { TelegramCallHandler } from "./call-handler.js";

const _require = createRequire(import.meta.url);
const wrtc = _require("@roamhq/wrtc") as typeof import("@roamhq/wrtc");
const { RTCPeerConnection, nonstandard } = wrtc;

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const FRAME_SIZE_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_SIZE_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * (BITS_PER_SAMPLE / 8);

const VAD_SILENCE_MS = 800;
const VAD_MIN_SPEECH_MS = 300;
const MAX_AUDIO_BUFFER = 320_000;

/** Active bridge session for one call. */
type BridgeSession = {
  callId: string;
  pc: InstanceType<typeof RTCPeerConnection> | null;
  audioSource: any;
  audioSink: any;
  audioChunks: Buffer[];
  totalBytes: number;
  lastAudioTime: number;
  isSpeaking: boolean;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  sessionKey: string;
};

/**
 * Bridges Telegram voice calls directly to the OpenClaw agent.
 */
export class TelegramVoiceBridge extends EventEmitter {
  private readonly config: TelegramVoiceConfig;
  readonly callHandler: TelegramCallHandler;
  private sessions = new Map<string, BridgeSession>();

  constructor(config: TelegramVoiceConfig) {
    super();
    this.config = config;
    this.callHandler = new TelegramCallHandler(config);
    this.setupEvents();
  }

  private setupEvents(): void {
    this.callHandler.on("callReady", ({ callId, phoneCall }) => {
      this.setupAudioBridge(callId, phoneCall);
    });

    this.callHandler.on("signalingData", async ({ callId, data }) => {
      await this.handleSignalingData(callId, data);
    });

    this.callHandler.on("event", (evt: VoiceBridgeEvent) => {
      if (evt.type === "call_ended") this.teardownSession(evt.callId);
      this.emit("event", evt);
    });
  }

  /** Set up WebRTC peer connection for a call with direct STT/TTS pipeline. */
  private async setupAudioBridge(callId: string, phoneCall: any): Promise<void> {
    if (this.sessions.has(callId)) return;

    const pc = new RTCPeerConnection({
      iceServers: this.extractIceServers(phoneCall),
    });

    const audioSource = new nonstandard.RTCAudioSource();
    const audioTrack = audioSource.createTrack();
    pc.addTrack(audioTrack);

    const session: BridgeSession = {
      callId,
      pc,
      audioSource,
      audioSink: null,
      audioChunks: [],
      totalBytes: 0,
      lastAudioTime: 0,
      isSpeaking: false,
      silenceTimer: null,
      processing: false,
      sessionKey: `telegram-voice:${callId}:${randomUUID()}`,
    };

    pc.ontrack = (event: any) => {
      if (event.track.kind === "audio") {
        const sink = new nonstandard.RTCAudioSink(event.track);
        sink.ondata = (data: { samples: Int16Array; sampleRate: number; channelCount: number }) => {
          const pcm = this.resampleToPcm16(data.samples, data.sampleRate, data.channelCount);
          this.handleIncomingAudio(session, pcm);
        };
        session.audioSink = sink;
      }
    };

    pc.onicecandidate = async (event: any) => {
      if (event.candidate) {
        const sigData = Buffer.from(
          JSON.stringify({ type: "candidate", candidate: event.candidate }),
        );
        await this.callHandler.sendSignalingData(callId, sigData);
      }
    };

    pc.onconnectionstatechange = () => {
      this.log(`Call ${callId} WebRTC: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.callHandler.endCall(callId, "webrtc_" + pc.connectionState);
      }
    };

    this.sessions.set(callId, session);

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    if (offer.sdp) {
      await this.callHandler.sendSignalingData(
        callId,
        Buffer.from(JSON.stringify({ type: "offer", sdp: offer.sdp })),
      );
    }

    this.log(`Audio bridge set up for call ${callId}`);
  }

  /** VAD + accumulation of incoming audio from Telegram. */
  private handleIncomingAudio(session: BridgeSession, pcm: Buffer): void {
    const rms = calculateRms(pcm);
    const now = Date.now();

    if (rms > VAD_SILENCE_THRESHOLD) {
      session.lastAudioTime = now;
      if (!session.isSpeaking) {
        session.isSpeaking = true;
        this.log(`Call ${session.callId}: speech start`);
      }
    }

    if (session.isSpeaking) {
      session.audioChunks.push(pcm);
      session.totalBytes += pcm.length;

      if (session.totalBytes > MAX_AUDIO_BUFFER) {
        session.audioChunks.shift();
        session.totalBytes = session.audioChunks.reduce((s, c) => s + c.length, 0);
      }

      if (session.silenceTimer) clearTimeout(session.silenceTimer);
      if (rms <= VAD_SILENCE_THRESHOLD) {
        session.silenceTimer = setTimeout(() => {
          const speechDuration = now - (session.lastAudioTime - VAD_SILENCE_MS);
          if (speechDuration >= VAD_MIN_SPEECH_MS) {
            void this.processAudio(session);
          } else {
            session.audioChunks = [];
            session.totalBytes = 0;
          }
          session.isSpeaking = false;
        }, VAD_SILENCE_MS);
      }
    }
  }

  /** Process accumulated audio: STT → Agent → TTS → send back to Telegram. */
  private async processAudio(session: BridgeSession): Promise<void> {
    if (session.processing || session.audioChunks.length === 0) return;
    session.processing = true;

    const audioBuffer = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    session.totalBytes = 0;

    try {
      this.log(`Call ${session.callId}: transcribing ${audioBuffer.length} bytes`);
      const transcript = await transcribeAudio(audioBuffer);
      if (!transcript) {
        this.log(`Call ${session.callId}: no speech detected`);
        return;
      }
      this.log(`Call ${session.callId}: "${transcript}"`);

      const runId = `tgvoice_${randomUUID()}`;
      let responseText = "";

      const result = await agentCommand(
        {
          message: transcript,
          sessionKey: session.sessionKey,
          runId,
          deliver: false,
          messageChannel: "voice",
          bestEffortDeliver: false,
          agentId: this.config.agentId || undefined,
        },
        defaultRuntime,
        createDefaultDeps(),
      );

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      responseText = Array.isArray(payloads)
        ? payloads
            .map((p) => p.text ?? "")
            .filter(Boolean)
            .join("\n\n")
        : "";

      if (!responseText.trim()) {
        this.log(`Call ${session.callId}: no response from agent`);
        return;
      }

      this.log(`Call ${session.callId}: TTS for "${responseText.slice(0, 60)}..."`);
      const cfg = loadConfig();
      const tts = await textToSpeechTelephony({ text: responseText, cfg });
      if (tts.success && tts.audioBuffer) {
        this.feedAudioToTelegram(session, tts.audioBuffer);
      }
    } catch (err) {
      this.log(`Call ${session.callId}: error: ${err}`);
      this.emitEvent({ type: "error", callId: session.callId, message: String(err) });
    } finally {
      session.processing = false;
    }
  }

  /** Feed PCM16 audio from TTS into WebRTC audio source → Telegram. */
  private feedAudioToTelegram(session: BridgeSession, pcm: Buffer): void {
    if (!session.audioSource) return;

    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      const frameEnd = Math.min(offset + FRAME_BYTES, pcm.length);
      const frame = pcm.subarray(offset, frameEnd);
      const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);

      session.audioSource.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: BITS_PER_SAMPLE,
        channelCount: CHANNELS,
        numberOfFrames: samples.length,
      });
    }
  }

  /** Handle incoming signaling data from Telegram. */
  private async handleSignalingData(callId: string, data: Buffer): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session?.pc) return;

    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "answer" && msg.sdp) {
        await session.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } else if (msg.type === "offer" && msg.sdp) {
        await session.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);
        if (answer.sdp) {
          await this.callHandler.sendSignalingData(
            callId,
            Buffer.from(JSON.stringify({ type: "answer", sdp: answer.sdp })),
          );
        }
      } else if (msg.type === "candidate" && msg.candidate) {
        await session.pc.addIceCandidate(msg.candidate);
      }
    } catch (err) {
      this.log(`Signaling parse error for call ${callId}: ${err}`);
    }
  }

  /** Resample received WebRTC audio to PCM16 mono 16kHz. */
  private resampleToPcm16(samples: Int16Array, sampleRate: number, channelCount: number): Buffer {
    let mono: Int16Array;
    if (channelCount > 1) {
      mono = new Int16Array(samples.length / channelCount);
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (let ch = 0; ch < channelCount; ch++) sum += samples[i * channelCount + ch];
        mono[i] = Math.round(sum / channelCount);
      }
    } else {
      mono = samples;
    }

    if (sampleRate !== SAMPLE_RATE) {
      const ratio = sampleRate / SAMPLE_RATE;
      const outLen = Math.floor(mono.length / ratio);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const idx = Math.floor(srcIdx);
        const frac = srcIdx - idx;
        out[i] = Math.round(
          (mono[idx] ?? 0) + frac * ((mono[idx + 1] ?? mono[idx] ?? 0) - (mono[idx] ?? 0)),
        );
      }
      mono = out;
    }
    return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength);
  }

  /** Extract ICE servers from Telegram phone call connection info. */
  private extractIceServers(phoneCall: any): RTCIceServer[] {
    const servers: RTCIceServer[] = [];
    const connections = phoneCall.connections ?? phoneCall.alternativeConnections ?? [];
    for (const conn of connections) {
      if (conn.ip && conn.port) servers.push({ urls: `stun:${conn.ip}:${conn.port}` });
    }
    return servers.length > 0 ? servers : [{ urls: "stun:stun.l.google.com:19302" }];
  }

  /** Tear down a bridge session. */
  private teardownSession(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    if (session.audioSink)
      try {
        session.audioSink.stop();
      } catch {
        /* */
      }
    if (session.pc)
      try {
        session.pc.close();
      } catch {
        /* */
      }
    this.sessions.delete(callId);
    this.log(`Torn down session for call ${callId}`);
  }

  async endCall(callId: string, reason = "local_hangup"): Promise<void> {
    await this.callHandler.endCall(callId, reason);
  }

  async destroy(): Promise<void> {
    for (const callId of this.sessions.keys()) this.teardownSession(callId);
    await this.callHandler.destroy();
  }

  private emitEvent(evt: VoiceBridgeEvent): void {
    this.emit("event", evt);
  }
  private log(msg: string): void {
    console.log(`[tg-voice-bridge] ${msg}`);
  }
}
