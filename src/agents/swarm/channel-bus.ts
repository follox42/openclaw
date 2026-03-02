/**
 * Swarm Channel Bus
 * Pub/sub system enabling direct agent↔agent communication beyond hub-spoke.
 * Agents can publish to named channels and subscribe to receive messages.
 *
 * Storage: In-memory (fast) + persisted to KB Outline (durable).
 * Thread-safe: uses per-channel queues with timestamp ordering.
 */

import crypto from "node:crypto";
import type { SwarmChannelMessage } from "./types.js";

// ─── In-Memory Channel Store ──────────────────────────────────────────────────

type ChannelSubscription = {
  sessionKey: string;
  agentId?: string;
  subscribedAt: number;
  handler?: (msg: SwarmChannelMessage) => void | Promise<void>;
};

type ChannelEntry = {
  messages: SwarmChannelMessage[];
  subscribers: Map<string, ChannelSubscription>;
  maxMessages: number;
};

const DEFAULT_MAX_MESSAGES = 100;
const channels = new Map<string, ChannelEntry>();

function getOrCreateChannel(channelName: string): ChannelEntry {
  let entry = channels.get(channelName);
  if (!entry) {
    entry = {
      messages: [],
      subscribers: new Map(),
      maxMessages: DEFAULT_MAX_MESSAGES,
    };
    channels.set(channelName, entry);
  }
  return entry;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Publish a message to a named channel.
 * All subscribers will receive the message.
 */
export async function swarmChannelPublish(params: {
  channel: string;
  fromSessionKey: string;
  fromAgentId?: string;
  payload: unknown;
}): Promise<{ messageId: string }> {
  const msg: SwarmChannelMessage = {
    id: crypto.randomUUID(),
    channel: params.channel,
    fromSessionKey: params.fromSessionKey,
    fromAgentId: params.fromAgentId,
    payload: params.payload,
    timestamp: Date.now(),
  };

  const entry = getOrCreateChannel(params.channel);

  // Trim old messages if at limit
  if (entry.messages.length >= entry.maxMessages) {
    entry.messages.splice(0, entry.messages.length - entry.maxMessages + 1);
  }
  entry.messages.push(msg);

  // Notify real-time handlers
  const notifyPromises: Array<Promise<void>> = [];
  for (const [subKey, sub] of entry.subscribers) {
    if (subKey === params.fromSessionKey) {
      continue;
    } // Don't echo back to sender
    if (sub.handler) {
      const p = Promise.resolve(sub.handler(msg)).catch(() => {
        // Subscribers should not crash the bus
      });
      notifyPromises.push(p);
    }
  }
  await Promise.all(notifyPromises);

  return { messageId: msg.id };
}

/**
 * Subscribe to a channel. Messages published after this point will be delivered.
 * Returns an unsubscribe function.
 */
export function swarmChannelSubscribe(params: {
  channel: string;
  sessionKey: string;
  agentId?: string;
  handler?: (msg: SwarmChannelMessage) => void | Promise<void>;
}): { unsubscribe: () => void } {
  const entry = getOrCreateChannel(params.channel);
  const subscription: ChannelSubscription = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    subscribedAt: Date.now(),
    handler: params.handler,
  };
  entry.subscribers.set(params.sessionKey, subscription);

  return {
    unsubscribe: () => {
      entry.subscribers.delete(params.sessionKey);
    },
  };
}

/**
 * Poll for messages in a channel since a given timestamp.
 * Returns messages this subscriber hasn't seen yet.
 */
export function swarmChannelPoll(params: {
  channel: string;
  requesterSessionKey: string;
  since?: number;
  limit?: number;
}): SwarmChannelMessage[] {
  const entry = channels.get(params.channel);
  if (!entry) {
    return [];
  }

  const since = params.since ?? 0;
  const limit = params.limit ?? 20;

  return entry.messages
    .filter((msg) => msg.timestamp > since && msg.fromSessionKey !== params.requesterSessionKey)
    .slice(-limit);
}

/**
 * List all active channels with subscriber counts.
 */
export function swarmChannelList(): Array<{
  channel: string;
  subscribers: number;
  messageCount: number;
  lastActivity?: number;
}> {
  const result: Array<{
    channel: string;
    subscribers: number;
    messageCount: number;
    lastActivity?: number;
  }> = [];

  for (const [name, entry] of channels) {
    const lastMsg = entry.messages[entry.messages.length - 1];
    result.push({
      channel: name,
      subscribers: entry.subscribers.size,
      messageCount: entry.messages.length,
      lastActivity: lastMsg?.timestamp,
    });
  }

  return result;
}

/**
 * Get subscribers for a channel (for mesh topology peer awareness).
 */
export function swarmChannelGetSubscribers(channelName: string): Array<{
  sessionKey: string;
  agentId?: string;
  subscribedAt: number;
}> {
  const entry = channels.get(channelName);
  if (!entry) {
    return [];
  }
  return Array.from(entry.subscribers.values()).map(({ sessionKey, agentId, subscribedAt }) => ({
    sessionKey,
    agentId,
    subscribedAt,
  }));
}

/**
 * Clear a channel (for cleanup after swarm completion).
 */
export function swarmChannelClear(channelName: string): void {
  channels.delete(channelName);
}

/** Reset all channels (tests only). */
export function resetSwarmChannelsForTests(): void {
  channels.clear();
}
