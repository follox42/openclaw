/**
 * @module telegram-voice/start
 * Starts the Telegram voice call bridge (gramjs userbot + call handler).
 * Called from the Telegram monitor when voice is enabled.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadVoiceConfigFromOpenClaw, readSessionString } from "./config.js";
import { TelegramVoiceBridge } from "./voice-bridge.js";

export type TelegramVoiceHandle = {
  bridge: TelegramVoiceBridge;
  client: TelegramClient;
  destroy: () => Promise<void>;
};

/**
 * Start the Telegram voice bridge if enabled in config.
 * Returns a handle for cleanup, or null if voice is not enabled.
 */
export async function startTelegramVoice(
  cfg: OpenClawConfig,
  opts?: { abortSignal?: AbortSignal; log?: (...args: unknown[]) => void },
): Promise<TelegramVoiceHandle | null> {
  const log = opts?.log ?? console.log;
  const voiceConfig = loadVoiceConfigFromOpenClaw(cfg);
  if (!voiceConfig) {
    return null;
  }

  if (!voiceConfig.apiId || !voiceConfig.apiHash) {
    log("[tg-voice] Voice enabled but apiId/apiHash missing, skipping");
    return null;
  }

  const sessionStr = readSessionString(voiceConfig.sessionPath);
  if (!sessionStr) {
    log("[tg-voice] No session file found at", voiceConfig.sessionPath, "— skipping voice");
    return null;
  }

  log("[tg-voice] Starting voice bridge...");

  const client = new TelegramClient(
    new StringSession(sessionStr),
    voiceConfig.apiId,
    voiceConfig.apiHash,
    { connectionRetries: 5 },
  );

  await client.connect();
  const me = await client.getMe();
  const name = (me as any)?.firstName ?? "unknown";
  log(`[tg-voice] Connected as ${name} (userbot)`);

  const bridge = new TelegramVoiceBridge(voiceConfig);
  await bridge.callHandler.start(client);

  bridge.on("event", (evt) => {
    log(
      "[tg-voice]",
      JSON.stringify(evt, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });

  const allowedStr = voiceConfig.allowedUserIds.map(String).join(", ") || "all";
  log(
    `[tg-voice] Listening for calls (allowed: ${allowedStr}, autoAnswer: ${voiceConfig.autoAnswer})`,
  );

  // Cleanup on abort
  const onAbort = async () => {
    log("[tg-voice] Shutting down voice bridge...");
    await bridge.destroy();
    await client.disconnect();
  };

  opts?.abortSignal?.addEventListener("abort", () => void onAbort(), { once: true });

  return {
    bridge,
    client,
    destroy: async () => {
      await bridge.destroy();
      await client.disconnect();
    },
  };
}
