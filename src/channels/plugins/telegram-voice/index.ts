/**
 * @module telegram-voice
 * Telegram P2P voice call bridge for OpenClaw.
 *
 * Uses gramjs for MTProto signaling and @roamhq/wrtc for WebRTC audio transport.
 * Bridges Telegram voice calls to the agent via STT → Agent → TTS.
 */

export { TelegramCallHandler } from "./call-handler.js";
export { TelegramVoiceBridge } from "./voice-bridge.js";
export {
  loadVoiceConfig,
  loadVoiceConfigFromOpenClaw,
  isUserAllowed,
  readSessionString,
} from "./config.js";
export type { TelegramVoiceConfig } from "./config.js";
export type { VoiceBridgeEvent, VoiceCallState, ActiveCall } from "./types.js";
export { startTelegramVoice } from "./start.js";
