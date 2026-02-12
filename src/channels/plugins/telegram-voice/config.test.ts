import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadVoiceConfig, loadVoiceConfigFromOpenClaw, isUserAllowed } from "./config.js";

describe("loadVoiceConfig", () => {
  it("returns defaults when no env vars set", () => {
    const config = loadVoiceConfig();
    expect(config.autoAnswer).toBe(true);
    expect(config.maxDurationSec).toBe(300);
    expect(config.agentId).toBe("main");
  });

  it("accepts overrides", () => {
    const config = loadVoiceConfig({ maxDurationSec: 600, debug: true });
    expect(config.maxDurationSec).toBe(600);
    expect(config.debug).toBe(true);
  });

  it("parses allowed user IDs from default", () => {
    const config = loadVoiceConfig();
    expect(config.allowedUserIds).toContain(6816067765n);
  });
});

describe("loadVoiceConfigFromOpenClaw", () => {
  it("returns null when voice not enabled", () => {
    const cfg = { channels: { telegram: {} } } as unknown as OpenClawConfig;
    expect(loadVoiceConfigFromOpenClaw(cfg)).toBeNull();
  });

  it("returns config when voice enabled", () => {
    const cfg = {
      channels: {
        telegram: {
          voice: {
            enabled: true,
            apiId: 12345,
            apiHash: "abc",
            allowFrom: ["111", "222"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = loadVoiceConfigFromOpenClaw(cfg);
    expect(result).not.toBeNull();
    expect(result!.apiId).toBe(12345);
    expect(result!.allowedUserIds).toEqual([111n, 222n]);
  });
});

describe("isUserAllowed", () => {
  it("allows listed users", () => {
    const config = loadVoiceConfig({ allowedUserIds: [123n, 456n] });
    expect(isUserAllowed(config, 123n)).toBe(true);
    expect(isUserAllowed(config, 789n)).toBe(false);
  });

  it("allows all when list is empty", () => {
    const config = loadVoiceConfig({ allowedUserIds: [] });
    expect(isUserAllowed(config, 999n)).toBe(true);
  });
});
