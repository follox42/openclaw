import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the voice WebSocket module.
 * Tests the internal helpers without starting a real server.
 * For full E2E tests with a running gateway, see voice-ws.e2e.test.ts.
 */

// We test the module's exported factory function in isolation.
// The heavy integration (agent, TTS) is tested in E2E.

describe("voice-ws module", () => {
  it("exports createVoiceWss as a function", async () => {
    const mod = await import("./voice-ws.js");
    expect(typeof mod.createVoiceWss).toBe("function");
  });

  it("createVoiceWss returns an object with handleUpgrade", async () => {
    const { createVoiceWss } = await import("./voice-ws.js");
    const wss = createVoiceWss({
      resolvedAuth: { mode: "token", token: "test-secret", allowTailscale: false },
    });
    expect(wss).toHaveProperty("handleUpgrade");
    expect(typeof wss.handleUpgrade).toBe("function");
  });

  it("handleUpgrade returns false for non-voice paths", async () => {
    const { createVoiceWss } = await import("./voice-ws.js");
    const wss = createVoiceWss({
      resolvedAuth: { mode: "token", token: "test-secret", allowTailscale: false },
    });

    // Simulate a request to a different path
    const fakeReq = { url: "/some/other/path", headers: {} } as never;
    const fakeSocket = { write: vi.fn(), destroy: vi.fn() } as never;
    const fakeHead = Buffer.alloc(0);

    const handled = wss.handleUpgrade(fakeReq, fakeSocket, fakeHead);
    expect(handled).toBe(false);
  });

  it("handleUpgrade returns true for /voice/ws path", async () => {
    const { createVoiceWss } = await import("./voice-ws.js");
    const wss = createVoiceWss({
      resolvedAuth: { mode: "token", token: "test-secret", allowTailscale: false },
    });

    const fakeReq = {
      url: "/voice/ws?token=test-secret",
      headers: { upgrade: "websocket" },
    } as never;
    const fakeSocket = {
      write: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as never;
    const fakeHead = Buffer.alloc(0);

    const handled = wss.handleUpgrade(fakeReq, fakeSocket, fakeHead);
    expect(handled).toBe(true);
  });
});
