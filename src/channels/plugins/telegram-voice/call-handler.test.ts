import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TelegramVoiceConfig } from "./config.js";
import { TelegramCallHandler } from "./call-handler.js";

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

describe("TelegramCallHandler", () => {
  let handler: TelegramCallHandler;

  beforeEach(() => {
    handler = new TelegramCallHandler(makeConfig());
  });

  it("creates with no active calls", () => {
    expect(handler.getActiveCalls()).toEqual([]);
  });

  it("getCall returns undefined for nonexistent call", () => {
    expect(handler.getCall("999")).toBeUndefined();
  });

  it("emits events via EventEmitter", () => {
    const fn = vi.fn();
    handler.on("event", fn);
    // Manually emit to test the pattern
    handler.emit("event", { type: "call_ended", callId: "1", reason: "test" });
    expect(fn).toHaveBeenCalledWith({ type: "call_ended", callId: "1", reason: "test" });
  });

  it("destroy cleans up without error", async () => {
    await expect(handler.destroy()).resolves.toBeUndefined();
  });
});
