# Telegram Voice Call Bridge

## Overview

Bridges Telegram P2P voice calls to the OpenClaw gateway `/voice/ws` WebSocket endpoint,
enabling real-time voice conversations with the AI agent via Telegram phone calls.

## Architecture

```
┌─────────────┐     MTProto      ┌──────────────────┐    WebSocket     ┌─────────────┐
│  Telegram    │ ◄──signaling───► │  call-handler.ts │                  │   Gateway    │
│  User Call   │                  │  (gramjs)        │                  │  /voice/ws   │
│              │     WebRTC       │                  │                  │              │
│  Audio ◄────►│ ◄──SRTP/UDP───► │  voice-bridge.ts │ ◄──PCM16 bin──► │  STT → Agent │
│              │                  │  (@roamhq/wrtc)  │                  │  → TTS       │
└─────────────┘                  └──────────────────┘                  └─────────────┘
```

## Components

### `config.ts`

Configuration from environment variables. Defines API credentials, allowed users,
gateway connection details, and call behavior settings.

### `call-handler.ts`

MTProto signaling via gramjs (the `telegram` npm package):

- **Incoming calls**: Receives `UpdatePhoneCall` → `PhoneCallRequested` → auto-accepts
- **Outgoing calls**: `phone.requestCall` → DH key exchange → `phone.confirmCall`
- **Key exchange**: Diffie-Hellman (g^a mod p / g^b mod p) per Telegram's protocol
- **Signaling data**: `phone.sendSignalingData` for WebRTC SDP/ICE exchange (protocol v6+)
- **Call lifecycle**: ringing → connecting → active → ended

### `voice-bridge.ts`

Audio transport bridge using `@roamhq/wrtc`:

- Creates `RTCPeerConnection` with ICE servers from Telegram call info
- `RTCAudioSource` feeds gateway TTS audio → Telegram
- `RTCAudioSink` captures Telegram audio → PCM16 → gateway WS
- Handles SDP offer/answer and ICE candidate exchange via signaling data
- Resamples audio to PCM16 mono 16kHz for the gateway

### `types.ts`

Shared type definitions: call states, bridge events, active call tracking.

### `index.ts`

Clean public API exports.

## Call Flow (Incoming)

1. Remote user calls the Telegram account
2. `UpdatePhoneCall` with `PhoneCallRequested` arrives via gramjs
3. `call-handler` checks user allowlist, sends `phone.receivedCall`
4. If auto-answer: `phone.acceptCall` with DH g_b parameter
5. Remote sends `phone.confirmCall` with g_a → shared key derived
6. `PhoneCall` update arrives → `callReady` event emitted
7. `voice-bridge` creates WebRTC peer connection + gateway WS
8. SDP offer sent via `phone.sendSignalingData`
9. Remote answers → WebRTC connected → audio flows bidirectionally
10. Telegram audio → PCM16 → gateway WS → STT → Agent → TTS → PCM16 → Telegram audio

## Dependencies

- **`telegram`** (gramjs): MTProto client for Telegram userbot auth and call signaling
- **`@roamhq/wrtc`**: Node.js WebRTC implementation (maintained fork of `wrtc`)
- **`ws`**: WebSocket client for gateway connection (already in project)

## Configuration (Environment Variables)

| Variable                 | Description                          | Default                         |
| ------------------------ | ------------------------------------ | ------------------------------- |
| `TG_API_ID`              | Telegram API ID from my.telegram.org | required                        |
| `TG_API_HASH`            | Telegram API Hash                    | required                        |
| `TG_SESSION_PATH`        | Path to save gramjs session          | `./telegram-voice.session`      |
| `TG_VOICE_ALLOWED_USERS` | Comma-separated Telegram user IDs    | `6816067765`                    |
| `TG_VOICE_AUTO_ANSWER`   | Auto-answer incoming calls           | `true`                          |
| `TG_VOICE_MAX_DURATION`  | Max call duration (seconds)          | `300`                           |
| `TG_VOICE_DEBUG`         | Verbose logging                      | `false`                         |
| `GATEWAY_VOICE_URL`      | Gateway voice WS URL                 | `ws://127.0.0.1:18789/voice/ws` |
| `GATEWAY_TOKEN`          | Gateway auth token                   | required                        |
| `VOICE_AGENT_ID`         | Agent ID for voice sessions          | `main`                          |

## Important Notes

- **Userbot required**: Telegram bots cannot make/receive voice calls. This uses a user account via gramjs.
- **First run**: Interactive auth required (phone number + verification code). Session is saved for reuse.
- **Protocol version**: Uses Telegram VoIP protocol layer 92 with library versions 6.0.0/7.0.0.
- **Audio format**: PCM16 mono 16kHz between bridge and gateway (WebRTC handles codec negotiation with Telegram).

## Testing

```bash
# Unit tests
npx vitest run src/channels/plugins/telegram-voice/

# Standalone integration test
TG_API_ID=... TG_API_HASH=... GATEWAY_TOKEN=... npx tsx src/channels/plugins/telegram-voice/test-bridge.ts
```
