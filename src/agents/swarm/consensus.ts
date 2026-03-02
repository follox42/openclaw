/**
 * Swarm Consensus Algorithms
 * Simple consensus mechanisms for collective decision-making.
 *
 * Algorithms:
 *   vote     — Majority vote on options
 *   raft     — Leader election via Raft-like term voting
 *   bft      — Byzantine fault-tolerant voting (requires 2f+1 votes)
 *   gossip   — State spreading via gossip protocol
 *
 * All state stored in-memory + serializable for KB persistence.
 */

import crypto from "node:crypto";
import type { ConsensusVote, RaftState } from "./types.js";

// ─── Vote Registry ────────────────────────────────────────────────────────────

const votes = new Map<string, ConsensusVote>();
const raftStates = new Map<string, RaftState>();

// ─── Majority Vote ────────────────────────────────────────────────────────────

/**
 * Create a new vote.
 */
export function createVote(params: {
  swarmId: string;
  topic: string;
  options: string[];
  requiredMajority?: number;
  ttlMs?: number;
}): ConsensusVote {
  const voteId = crypto.randomUUID();
  const vote: ConsensusVote = {
    voteId,
    swarmId: params.swarmId,
    topic: params.topic,
    options: params.options,
    votes: {},
    requiredMajority: params.requiredMajority ?? 0.5,
    deadline: Date.now() + (params.ttlMs ?? 60_000),
    finalized: false,
  };
  votes.set(voteId, vote);
  return vote;
}

/**
 * Cast a vote.
 */
export function castVote(params: { voteId: string; sessionKey: string; option: string }): {
  ok: boolean;
  error?: string;
  vote?: ConsensusVote;
} {
  const vote = votes.get(params.voteId);
  if (!vote) {
    return { ok: false, error: `Vote ${params.voteId} not found` };
  }
  if (vote.finalized) {
    return { ok: false, error: "Vote already finalized" };
  }
  if (Date.now() > vote.deadline) {
    return { ok: false, error: "Vote deadline passed" };
  }
  if (!vote.options.includes(params.option)) {
    return {
      ok: false,
      error: `Invalid option "${params.option}". Valid: ${vote.options.join(", ")}`,
    };
  }
  vote.votes[params.sessionKey] = params.option;
  votes.set(params.voteId, vote);
  return { ok: true, vote };
}

/**
 * Tally votes and finalize if majority reached.
 */
export function tallyVote(voteId: string): {
  result?: string;
  finalized: boolean;
  tally: Record<string, number>;
  totalVotes: number;
  vote: ConsensusVote | undefined;
} {
  const vote = votes.get(voteId);
  if (!vote) {
    return { finalized: false, tally: {}, totalVotes: 0, vote: undefined };
  }

  const tally: Record<string, number> = {};
  for (const opt of vote.options) {
    tally[opt] = 0;
  }
  for (const chosen of Object.values(vote.votes)) {
    if (tally[chosen] !== undefined) {
      tally[chosen]++;
    }
  }

  const totalVotes = Object.keys(vote.votes).length;

  // Check for majority
  let winner: string | undefined;
  for (const [option, count] of Object.entries(tally)) {
    if (totalVotes > 0 && count / totalVotes > vote.requiredMajority) {
      winner = option;
      break;
    }
  }

  // Auto-finalize if deadline passed or winner found
  const expired = Date.now() > vote.deadline;
  if ((winner || expired) && !vote.finalized) {
    vote.result = winner;
    vote.finalized = true;
    votes.set(voteId, vote);
  }

  return { result: vote.result, finalized: vote.finalized, tally, totalVotes, vote };
}

/**
 * Get vote status.
 */
export function getVote(voteId: string): ConsensusVote | undefined {
  return votes.get(voteId);
}

// ─── Raft Leader Election ─────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * Initialize Raft state for a swarm.
 */
export function raftInit(swarmId: string): RaftState {
  const existing = raftStates.get(swarmId);
  if (existing) {
    return existing;
  }

  const state: RaftState = {
    swarmId,
    term: 0,
    leaderId: undefined,
    votes: {},
    log: [],
    commitIndex: -1,
    lastHeartbeat: Date.now(),
  };
  raftStates.set(swarmId, state);
  return state;
}

/**
 * Request a vote (candidate step).
 */
export function raftRequestVote(params: {
  swarmId: string;
  candidateSessionKey: string;
  term: number;
}): { granted: boolean; currentTerm: number } {
  const state = raftInit(params.swarmId);

  // Accept if term is newer
  if (params.term > state.term) {
    state.term = params.term;
    state.leaderId = undefined;
    state.votes[params.swarmId] = params.candidateSessionKey;
    raftStates.set(params.swarmId, state);
    return { granted: true, currentTerm: state.term };
  }

  // Already voted this term
  const voted = state.votes[params.swarmId];
  if (state.term === params.term && (!voted || voted === params.candidateSessionKey)) {
    state.votes[params.swarmId] = params.candidateSessionKey;
    raftStates.set(params.swarmId, state);
    return { granted: true, currentTerm: state.term };
  }

  return { granted: false, currentTerm: state.term };
}

/**
 * Announce leader (called after receiving majority votes).
 */
export function raftAnnounceLeader(params: {
  swarmId: string;
  leaderId: string;
  term: number;
}): RaftState {
  const state = raftInit(params.swarmId);
  if (params.term >= state.term) {
    state.term = params.term;
    state.leaderId = params.leaderId;
    state.lastHeartbeat = Date.now();
    raftStates.set(params.swarmId, state);
  }
  return state;
}

/**
 * Send heartbeat from leader (resets timeout).
 */
export function raftHeartbeat(swarmId: string, leaderId: string): boolean {
  const state = raftStates.get(swarmId);
  if (!state || state.leaderId !== leaderId) {
    return false;
  }
  state.lastHeartbeat = Date.now();
  raftStates.set(swarmId, state);
  return true;
}

/**
 * Check if current leader is still alive.
 */
export function raftIsLeaderAlive(swarmId: string): boolean {
  const state = raftStates.get(swarmId);
  if (!state || !state.leaderId) {
    return false;
  }
  return Date.now() - state.lastHeartbeat < HEARTBEAT_TIMEOUT_MS;
}

/**
 * Get current Raft state.
 */
export function raftGetState(swarmId: string): RaftState | undefined {
  return raftStates.get(swarmId);
}

// ─── BFT (Byzantine Fault Tolerant) ──────────────────────────────────────────

/**
 * BFT vote: requires 2f+1 votes where f = floor((n-1)/3)
 */
export function bftVote(params: {
  swarmId: string;
  topic: string;
  option: string;
  memberCount: number;
}): { vote: ConsensusVote } {
  const voteId = `bft:${params.swarmId}:${params.topic}`;
  let vote = votes.get(voteId);

  if (!vote) {
    const f = Math.floor((params.memberCount - 1) / 3);
    const requiredMajority = Math.min(0.99, (2 * f + 1) / params.memberCount);
    vote = createVote({
      swarmId: params.swarmId,
      topic: params.topic,
      options: [params.option],
      requiredMajority,
    });
  } else if (!vote.options.includes(params.option)) {
    vote.options.push(params.option);
  }

  return { vote };
}

// ─── Gossip ───────────────────────────────────────────────────────────────────

const gossipState = new Map<string, Map<string, { value: unknown; version: number; ts: number }>>();

/**
 * Gossip: set a value for a key in the swarm.
 */
export function gossipSet(swarmId: string, key: string, value: unknown): void {
  let swarmGossip = gossipState.get(swarmId);
  if (!swarmGossip) {
    swarmGossip = new Map();
    gossipState.set(swarmId, swarmGossip);
  }
  const existing = swarmGossip.get(key);
  const version = (existing?.version ?? 0) + 1;
  swarmGossip.set(key, { value, version, ts: Date.now() });
}

/**
 * Gossip: get current value for a key.
 */
export function gossipGet(swarmId: string, key: string): unknown {
  return gossipState.get(swarmId)?.get(key)?.value;
}

/**
 * Gossip: merge state from another node (Last-Write-Wins by version).
 */
export function gossipMerge(
  swarmId: string,
  incoming: Record<string, { value: unknown; version: number; ts: number }>,
): void {
  let swarmGossip = gossipState.get(swarmId);
  if (!swarmGossip) {
    swarmGossip = new Map();
    gossipState.set(swarmId, swarmGossip);
  }

  for (const [key, incomingEntry] of Object.entries(incoming)) {
    const existing = swarmGossip.get(key);
    if (!existing || incomingEntry.version > existing.version) {
      swarmGossip.set(key, incomingEntry);
    }
  }
}

/**
 * Gossip: get all state for serialization to gossip to peers.
 */
export function gossipGetAll(
  swarmId: string,
): Record<string, { value: unknown; version: number; ts: number }> {
  const result: Record<string, { value: unknown; version: number; ts: number }> = {};
  const swarmGossip = gossipState.get(swarmId);
  if (!swarmGossip) {
    return result;
  }
  for (const [k, v] of swarmGossip) {
    result[k] = v;
  }
  return result;
}

/** Reset for tests. */
export function resetConsensusForTests(): void {
  votes.clear();
  raftStates.clear();
  gossipState.clear();
}
