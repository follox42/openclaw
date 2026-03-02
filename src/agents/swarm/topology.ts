/**
 * Swarm Topology Manager
 * Manages swarm state and computes peer connections based on topology.
 *
 * Topologies:
 *   star        — All agents connect to hub (default, backward-compatible)
 *   mesh        — All agents connect to all others (P2P)
 *   hierarchical — Leader → sub-groups → workers
 *   ring        — Linear pipeline: A → B → C → A
 */

import crypto from "node:crypto";
import type { SwarmMember, SwarmState, SwarmTopology, ConsensusAlgorithm } from "./types.js";

// ─── In-Memory Swarm Registry ─────────────────────────────────────────────────

const activeSwarms = new Map<string, SwarmState>();

// ─── Peer Computation ─────────────────────────────────────────────────────────

/**
 * Compute peer lists for each member based on topology.
 * Returns a map of sessionKey → peer session keys.
 */
export function computePeers(
  members: SwarmMember[],
  topology: SwarmTopology,
): Map<string, string[]> {
  const peerMap = new Map<string, string[]>();
  const allKeys = members.map((m) => m.sessionKey);

  switch (topology) {
    case "star": {
      // Hub-spoke: only hub gets all peers, spokes get no direct peers
      // (backward compatible — star = current behavior)
      for (const member of members) {
        peerMap.set(member.sessionKey, []);
      }
      break;
    }

    case "mesh": {
      // Full mesh: every agent connects to every other
      for (const member of members) {
        peerMap.set(
          member.sessionKey,
          allKeys.filter((k) => k !== member.sessionKey),
        );
      }
      break;
    }

    case "hierarchical": {
      // Leader (first member) gets all peers
      // Workers get leader + immediate neighbors
      const [leader, ...workers] = members;
      if (!leader) {
        break;
      }

      peerMap.set(
        leader.sessionKey,
        workers.map((w) => w.sessionKey),
      );

      for (let i = 0; i < workers.length; i++) {
        const worker = workers[i];
        if (!worker) {
          continue;
        }
        const peers: string[] = [leader.sessionKey];
        // Adjacent workers
        if (i > 0 && workers[i - 1]) {
          peers.push(workers[i - 1].sessionKey);
        }
        if (i < workers.length - 1 && workers[i + 1]) {
          peers.push(workers[i + 1].sessionKey);
        }
        peerMap.set(worker.sessionKey, peers);
      }
      break;
    }

    case "ring": {
      // Ring: each agent connects to next and previous
      for (let i = 0; i < members.length; i++) {
        const current = members[i];
        if (!current) {
          continue;
        }
        const prev = members[(i - 1 + members.length) % members.length];
        const next = members[(i + 1) % members.length];
        const peers: string[] = [];
        if (prev && prev.sessionKey !== current.sessionKey) {
          peers.push(prev.sessionKey);
        }
        if (next && next.sessionKey !== current.sessionKey) {
          peers.push(next.sessionKey);
        }
        peerMap.set(current.sessionKey, [...new Set(peers)]);
      }
      break;
    }
  }

  return peerMap;
}

// ─── Swarm CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a new swarm with optional initial members.
 */
export function createSwarm(params: {
  topology?: SwarmTopology;
  consensus?: ConsensusAlgorithm;
  metadata?: Record<string, unknown>;
}): SwarmState {
  const swarmId = `swarm-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const state: SwarmState = {
    swarmId,
    topology: params.topology ?? "star",
    consensus: params.consensus ?? "none",
    members: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: params.metadata,
  };
  activeSwarms.set(swarmId, state);
  return state;
}

/**
 * Get swarm state by ID.
 */
export function getSwarm(swarmId: string): SwarmState | undefined {
  return activeSwarms.get(swarmId);
}

/**
 * Add a member to an existing swarm.
 * Recomputes peer links based on current topology.
 */
export function addMember(
  swarmId: string,
  member: Omit<SwarmMember, "peers" | "joinedAt">,
): SwarmState | undefined {
  const state = activeSwarms.get(swarmId);
  if (!state) {
    return undefined;
  }

  const newMember: SwarmMember = {
    ...member,
    peers: [],
    joinedAt: Date.now(),
  };

  state.members.push(newMember);
  state.updatedAt = Date.now();

  // Assign leader if hierarchical and this is first member
  if (state.topology === "hierarchical" && state.members.length === 1) {
    state.leaderId = newMember.sessionKey;
  }

  // Recompute peer links
  const peerMap = computePeers(state.members, state.topology);
  for (const m of state.members) {
    m.peers = peerMap.get(m.sessionKey) ?? [];
  }

  activeSwarms.set(swarmId, state);
  return state;
}

/**
 * Remove a member from a swarm.
 */
export function removeMember(swarmId: string, sessionKey: string): SwarmState | undefined {
  const state = activeSwarms.get(swarmId);
  if (!state) {
    return undefined;
  }

  state.members = state.members.filter((m) => m.sessionKey !== sessionKey);
  state.updatedAt = Date.now();

  // If leader left, elect next member
  if (state.leaderId === sessionKey && state.members.length > 0) {
    state.leaderId = state.members[0]?.sessionKey;
  }

  // Recompute peer links
  const peerMap = computePeers(state.members, state.topology);
  for (const m of state.members) {
    m.peers = peerMap.get(m.sessionKey) ?? [];
  }

  activeSwarms.set(swarmId, state);
  return state;
}

/**
 * Get peer session keys for a member in a swarm.
 */
export function getMemberPeers(swarmId: string, sessionKey: string): string[] {
  const state = activeSwarms.get(swarmId);
  if (!state) {
    return [];
  }
  return state.members.find((m) => m.sessionKey === sessionKey)?.peers ?? [];
}

/**
 * List all active swarms.
 */
export function listSwarms(): SwarmState[] {
  return Array.from(activeSwarms.values());
}

/**
 * Delete a swarm.
 */
export function deleteSwarm(swarmId: string): boolean {
  return activeSwarms.delete(swarmId);
}

/**
 * Build the swarm context paragraph to inject into sub-agent system prompts.
 * This tells agents about their swarm membership and peers.
 */
export function buildSwarmContextPrompt(params: {
  swarmId: string;
  topology: SwarmTopology;
  sessionKey: string;
  peers: string[];
  role?: string;
  consensus: ConsensusAlgorithm;
}): string {
  const { swarmId, topology, sessionKey, peers, role, consensus } = params;
  const lines: string[] = [
    `## Swarm Context`,
    `You are part of a **${topology}** swarm (ID: \`${swarmId}\`).`,
    role ? `Your role: **${role}**` : "",
    `Your session: \`${sessionKey}\``,
    `Consensus: **${consensus}**`,
    "",
  ];

  if (peers.length > 0) {
    lines.push(`### Peer Agents (direct communication available)`);
    for (const peer of peers) {
      lines.push(`- \`${peer}\``);
    }
    lines.push("");
    lines.push(
      `You can send messages directly to peers using the \`sessions_send\` tool with their session key.`,
    );
    lines.push(
      `You can publish to shared channels using \`sessions_channel_publish\` and read via \`sessions_channel_poll\`.`,
    );
  } else if (topology === "star") {
    lines.push(`In star topology, communicate results back to your requester (hub-spoke mode).`);
  }

  if (consensus !== "none") {
    lines.push("");
    lines.push(
      `For consensus decisions, use \`sessions_consensus_vote\` with swarmId: \`${swarmId}\`.`,
    );
  }

  lines.push("");
  lines.push(
    `Shared swarm channel: \`swarm:${swarmId}\` — publish important findings for all peers.`,
  );

  return lines.filter((l) => l !== null).join("\n");
}

/** Reset for tests. */
export function resetSwarmsForTests(): void {
  activeSwarms.clear();
}
