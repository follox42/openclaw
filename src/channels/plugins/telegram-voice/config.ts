/**
 * @module telegram-voice/config
 * Configuration for Telegram voice call bridge.
 * Reads from OpenClaw config (channels.telegram.voice) with env fallbacks.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";

/** Configuration for the Telegram voice userbot and call bridge. */
export type TelegramVoiceConfig = {
  /** Telegram API ID (from my.telegram.org). */
  apiId: number;
  /** Telegram API Hash. */
  apiHash: string;
  /** Path to store the gramjs session file. */
  sessionPath: string;
  /** Telegram user IDs allowed to call/be called. Empty = allow all. */
  allowedUserIds: bigint[];
  /** Agent ID for voice sessions. */
  agentId: string;
  /** Auto-answer incoming calls from allowed users. */
  autoAnswer: boolean;
  /** Max call duration in seconds. */
  maxDurationSec: number;
  /** Enable verbose logging. */
  debug: boolean;
};

/** Resolve ~ in paths. */
function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
}

/** Read session string from file. */
export function readSessionString(sessionPath: string): string {
  const resolved = expandHome(sessionPath);
  if (!existsSync(resolved)) return "";
  return readFileSync(resolved, "utf-8").trim();
}

/** Load voice config from OpenClaw config or env with defaults. */
export function loadVoiceConfig(overrides?: Partial<TelegramVoiceConfig>): TelegramVoiceConfig {
  const env = process.env;
  const allowedRaw = env.TG_VOICE_ALLOWED_USERS ?? "6816067765";
  const allowedUserIds = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s));

  return {
    apiId: Number(env.TG_API_ID ?? "0"),
    apiHash: env.TG_API_HASH ?? "",
    sessionPath: env.TG_SESSION_PATH ?? "~/.clawdbot/credentials/telegram-voice.session",
    allowedUserIds,
    agentId: env.VOICE_AGENT_ID ?? "main",
    autoAnswer: env.TG_VOICE_AUTO_ANSWER !== "false",
    maxDurationSec: Number(env.TG_VOICE_MAX_DURATION ?? "300"),
    debug: env.TG_VOICE_DEBUG === "true",
    ...overrides,
  };
}

/** Load voice config from OpenClaw config object. */
export function loadVoiceConfigFromOpenClaw(cfg: OpenClawConfig): TelegramVoiceConfig | null {
  const tgCfg = cfg.channels?.telegram as Record<string, unknown> | undefined;
  const voice = tgCfg?.voice as Record<string, unknown> | undefined;
  if (!voice?.enabled) return null;

  const allowFrom = (voice.allowFrom as string[] | undefined) ?? [];
  const allowedUserIds = allowFrom.map((s) => BigInt(s));

  return {
    apiId: Number(voice.apiId ?? 0),
    apiHash: String(voice.apiHash ?? ""),
    sessionPath: String(voice.sessionFile ?? "~/.clawdbot/credentials/telegram-voice.session"),
    allowedUserIds,
    agentId: String(voice.agentId ?? "main"),
    autoAnswer: voice.autoAnswer !== false,
    maxDurationSec: Number(voice.maxDurationSec ?? 300),
    debug: voice.debug === true,
  };
}

/** Check if a user ID is allowed. Empty allowlist = allow all. */
export function isUserAllowed(config: TelegramVoiceConfig, userId: bigint): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}
