import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TelegramVoiceConfig } from "./config.js";
import { TelegramVoiceBridge } from "./voice-bridge.js";

const makeConfig = (overrides?: Partial<TelegramVoiceConfig>): TelegramVoiceConfig => ({
  apiId: 12345,
  apiHash: "test_hash",
  sessionPath: "./test.session",
  allowedUserIds: [6816067765n],
  gatewayVoiceUrl: "ws://127.0.0.1:18789/voice/ws",
  gatewayToken: "test_token",
  agentId: "main",
  autoAnswer: false,
  maxDurationSec: 300,
  debug: false,
  ...overrides,
});

describe("TelegramVoiceBridge", () => {
  let bridge: TelegramVoiceBridge;

  beforeEach(() => {
    bridge = new TelegramVoiceBridge(makeConfig());
  });

  it("creates with call handler", () => {
    expect(bridge.callHandler).toBeDefined();
    expect(bridge.callHandler.getActiveCalls()).toEqual([]);
  });

  it("emits forwarded events", () => {
    const fn = vi.fn();
    bridge.on("event", fn);
    bridge.callHandler.emit("event", { type: "call_ended", callId: "1", reason: "test" });
    expect(fn).toHaveBeenCalledWith({ type: "call_ended", callId: "1", reason: "test" });
  });

  it("destroy cleans up without error", async () => {
    await expect(bridge.destroy()).resolves.toBeUndefined();
  });

  it("endCall delegates to call handler", async () => {
    const spy = vi.spyOn(bridge.callHandler, "endCall").mockResolvedValue();
    await bridge.endCall("123", "test_reason");
    expect(spy).toHaveBeenCalledWith("123", "test_reason");
  });
});
