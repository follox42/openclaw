/**
 * Swarm Core Types
 * Core type definitions for the OpenClaw swarm multi-agent system.
 * Integrated from Ruflo v3.5 (ex-Claude-Flow).
 */

// ─── Topologies ───────────────────────────────────────────────────────────────

export const SWARM_TOPOLOGIES = ["star", "mesh", "hierarchical", "ring"] as const;
export type SwarmTopology = (typeof SWARM_TOPOLOGIES)[number];

// ─── Consensus ────────────────────────────────────────────────────────────────

export const CONSENSUS_ALGORITHMS = ["none", "raft", "bft", "gossip", "vote"] as const;
export type ConsensusAlgorithm = (typeof CONSENSUS_ALGORITHMS)[number];

// ─── Routing Tiers ────────────────────────────────────────────────────────────

export type RoutingTier = "t1" | "t2" | "t3";

// ─── Swarm Member ─────────────────────────────────────────────────────────────

export type SwarmMember = {
  sessionKey: string;
  agentId: string;
  label?: string;
  role?: string;
  /** Peer session keys this member can communicate with directly */
  peers: string[];
  joinedAt: number;
};

// ─── Swarm State ──────────────────────────────────────────────────────────────

export type SwarmState = {
  swarmId: string;
  topology: SwarmTopology;
  consensus: ConsensusAlgorithm;
  members: SwarmMember[];
  leaderId?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

// ─── Swarm Spawn Options ──────────────────────────────────────────────────────

export type SwarmSpawnOptions = {
  /** Existing swarm ID to join, or undefined to create new */
  swarmId?: string;
  topology?: SwarmTopology;
  consensus?: ConsensusAlgorithm;
  role?: string;
  enableLearning?: boolean;
};

// ─── Channel Message ──────────────────────────────────────────────────────────

export type SwarmChannelMessage = {
  id: string;
  channel: string;
  fromSessionKey: string;
  fromAgentId?: string;
  payload: unknown;
  timestamp: number;
};

// ─── Q-Learning ───────────────────────────────────────────────────────────────

export type QTableEntry = {
  state: string;
  action: string;
  value: number;
  visits: number;
  lastUpdated: number;
};

// ─── Task Metrics ─────────────────────────────────────────────────────────────

export type TaskMetrics = {
  taskId: string;
  sessionKey: string;
  agentId: string;
  model?: string;
  label?: string;
  taskDescription: string;
  complexityScore: number;
  tier: RoutingTier;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  outcome: "success" | "error" | "timeout" | "killed";
  qualityScore?: number;
  reward?: number;
};

// ─── Routing Decision ─────────────────────────────────────────────────────────

export type RoutingDecision = {
  tier: RoutingTier;
  model?: string;
  reasoning: string;
  complexityScore: number;
  qValue?: number;
};

// ─── Consensus Vote ───────────────────────────────────────────────────────────

export type ConsensusVote = {
  voteId: string;
  swarmId: string;
  topic: string;
  options: string[];
  votes: Record<string, string>; // sessionKey → option
  requiredMajority: number;
  deadline: number;
  result?: string;
  finalized: boolean;
};

// ─── Raft State ───────────────────────────────────────────────────────────────

export type RaftState = {
  swarmId: string;
  term: number;
  leaderId?: string;
  votes: Record<string, string>; // sessionKey → candidateId
  log: Array<{ term: number; entry: unknown }>;
  commitIndex: number;
  lastHeartbeat: number;
};
