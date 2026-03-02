/**
 * Sessions Channel Tool
 * Exposes swarm pub/sub channel bus to agents.
 * Enables direct agent↔agent communication beyond hub-spoke.
 *
 * Tools:
 *   sessions_channel_publish  — Publish message to a named channel
 *   sessions_channel_poll     — Poll for unread messages from a channel
 *   sessions_channel_list     — List active channels
 */

import { Type } from "@sinclair/typebox";
import {
  swarmChannelPublish,
  swarmChannelPoll,
  swarmChannelList,
  swarmChannelSubscribe,
} from "../swarm/channel-bus.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ─── Publish Tool ─────────────────────────────────────────────────────────────

const SessionsChannelPublishSchema = Type.Object({
  channel: Type.String({ description: "Channel name (e.g. swarm:my-swarm-id or custom/topic)" }),
  payload: Type.Unknown({ description: "Message payload (any JSON value)" }),
});

export function createSessionsChannelPublishTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Swarm Channel",
    name: "sessions_channel_publish",
    description:
      "Publish a message to a named swarm channel. All agents subscribed or polling this channel will receive it. Enables direct agent↔agent communication in mesh/hierarchical topologies.",
    parameters: SessionsChannelPublishSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const channel = readStringParam(params, "channel", { required: true });
      const payload = params.payload;

      if (!channel) {
        return jsonResult({ status: "error", error: "channel is required" });
      }

      const result = await swarmChannelPublish({
        channel,
        fromSessionKey: opts?.agentSessionKey ?? "unknown",
        fromAgentId: opts?.agentId,
        payload,
      });

      return jsonResult({ status: "ok", messageId: result.messageId, channel });
    },
  };
}

// ─── Poll Tool ────────────────────────────────────────────────────────────────

const SessionsChannelPollSchema = Type.Object({
  channel: Type.String({ description: "Channel name to poll" }),
  since: Type.Optional(
    Type.Number({ description: "Unix timestamp (ms) — only return messages after this" }),
  ),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 50, description: "Max messages (1-50)" }),
  ),
});

export function createSessionsChannelPollTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Swarm Channel",
    name: "sessions_channel_poll",
    description:
      "Poll for messages in a named swarm channel. Use `since` timestamp to get only new messages. Returns messages from other agents (not your own).",
    parameters: SessionsChannelPollSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const channel = readStringParam(params, "channel", { required: true });
      const since = typeof params.since === "number" ? params.since : 0;
      const limit = typeof params.limit === "number" ? Math.min(50, Math.max(1, params.limit)) : 20;

      if (!channel) {
        return jsonResult({ status: "error", error: "channel is required" });
      }

      // Auto-subscribe on first poll (so sender excludes us)
      swarmChannelSubscribe({
        channel,
        sessionKey: opts?.agentSessionKey ?? "unknown",
      });

      const messages = swarmChannelPoll({
        channel,
        requesterSessionKey: opts?.agentSessionKey ?? "unknown",
        since,
        limit,
      });

      const now = Date.now();
      return jsonResult({
        status: "ok",
        channel,
        messages,
        count: messages.length,
        polledAt: now,
        nextSince: messages.length > 0 ? Math.max(...messages.map((m) => m.timestamp)) : since,
      });
    },
  };
}

// ─── List Tool ────────────────────────────────────────────────────────────────

export function createSessionsChannelListTool(): AnyAgentTool {
  return {
    label: "Swarm Channel",
    name: "sessions_channel_list",
    description: "List all active swarm channels with subscriber counts and message counts.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _args) => {
      const channels = swarmChannelList();
      return jsonResult({ status: "ok", channels, count: channels.length });
    },
  };
}
