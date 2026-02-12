/**
 * @module telegram-voice/types
 * Type definitions for Telegram voice call bridge.
 */

/** Voice call state machine. */
export type VoiceCallState = "idle" | "ringing" | "connecting" | "active" | "ended";

/** Events emitted by the call handler and voice bridge. */
export type VoiceBridgeEvent =
  | { type: "call_incoming"; callId: string; userId: bigint }
  | { type: "call_accepted"; callId: string }
  | { type: "call_connected"; callId: string }
  | { type: "call_ended"; callId: string; reason: string }
  | { type: "audio_from_telegram"; callId: string; pcm: Buffer }
  | { type: "audio_to_telegram"; callId: string; pcm: Buffer }
  | { type: "error"; callId?: string; message: string };

/** Tracked active call. */
export type ActiveCall = {
  callId: string;
  /** Raw Telegram call object from gramjs. */
  phoneCall: unknown;
  state: VoiceCallState;
  userId: bigint;
  startTime?: number;
  durationTimer?: ReturnType<typeof setTimeout>;
  /** WebRTC peer connection for audio. */
  peerConnection?: RTCPeerConnection;
};
