import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatConfigChannelsStatusLines } from "./channels/status.js";

function makeUnavailableTokenPlugin(): ChannelPlugin {
  return {
    id: "token-only",
    meta: {
      id: "token-only",
      label: "TokenOnly",
      selectionLabel: "TokenOnly",
      docsPath: "/channels/token-only",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
        token: "",
        tokenSource: "config",
        tokenStatus: "configured_unavailable",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      listActions: () => ["send"],
    },
  };
}

describe("config-only channels status output", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("shows configured-but-unavailable credentials distinctly from not configured", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "token-only",
          source: "test",
          plugin: makeUnavailableTokenPlugin(),
        },
      ]),
    );

    const lines = await formatConfigChannelsStatusLines({ channels: {} } as never, {
      mode: "local",
    });

    const joined = lines.join("\n");
    expect(joined).toContain("TokenOnly");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });
});
