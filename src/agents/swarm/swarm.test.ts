/**
 * Swarm Core Unit Tests
 * Tests for topology, channel bus, Q-Learning router, consensus, and learning loop.
 */

import { describe, it, expect, beforeEach } from "vitest";
// ─── Topology ─────────────────────────────────────────────────────────────────
import {
  swarmChannelPublish,
  swarmChannelPoll,
  swarmChannelList,
  swarmChannelSubscribe,
  resetSwarmChannelsForTests,
} from "./channel-bus.js";
// ─── Channel Bus ──────────────────────────────────────────────────────────────
import {
  createVote,
  castVote,
  tallyVote,
  raftInit,
  raftRequestVote,
  raftAnnounceLeader,
  raftIsLeaderAlive,
  gossipSet,
  gossipGet,
  gossipMerge,
  resetConsensusForTests,
} from "./consensus.js";
// ─── Router ───────────────────────────────────────────────────────────────────
import {
  computeReward,
  getLearningStats,
  resetLearningForTests,
  runLearningLoop,
} from "./learning.js";
// ─── Consensus ────────────────────────────────────────────────────────────────
import {
  estimateTaskComplexity,
  complexityToTier,
  routeTask,
  recordTaskOutcome,
  serializeQTable,
  loadQTableFromData,
} from "./router.js";
// ─── Learning ─────────────────────────────────────────────────────────────────
import {
  createSwarm,
  getSwarm,
  addMember,
  removeMember,
  getMemberPeers,
  listSwarms,
  deleteSwarm,
  computePeers,
  buildSwarmContextPrompt,
  resetSwarmsForTests,
} from "./topology.js";

// =============================================================================
// TOPOLOGY TESTS
// =============================================================================

describe("Swarm Topology", () => {
  beforeEach(() => {
    resetSwarmsForTests();
  });

  it("creates a new swarm with star topology by default", () => {
    const swarm = createSwarm({});
    expect(swarm.swarmId).toMatch(/^swarm-\d+-[a-f0-9]+$/);
    expect(swarm.topology).toBe("star");
    expect(swarm.consensus).toBe("none");
    expect(swarm.members).toHaveLength(0);
  });

  it("creates a mesh swarm", () => {
    const swarm = createSwarm({ topology: "mesh", consensus: "raft" });
    expect(swarm.topology).toBe("mesh");
    expect(swarm.consensus).toBe("raft");
  });

  it("adds members to a swarm and computes star peers", () => {
    const swarm = createSwarm({ topology: "star" });
    addMember(swarm.swarmId, { sessionKey: "agent:main:subagent:A", agentId: "main" });
    addMember(swarm.swarmId, { sessionKey: "agent:main:subagent:B", agentId: "main" });
    addMember(swarm.swarmId, { sessionKey: "agent:main:subagent:C", agentId: "main" });

    // Star: all peers = []
    const peersA = getMemberPeers(swarm.swarmId, "agent:main:subagent:A");
    expect(peersA).toHaveLength(0);
  });

  it("computes mesh peers (all to all)", () => {
    const members = [
      { sessionKey: "sk:A", agentId: "a", peers: [], joinedAt: 0 },
      { sessionKey: "sk:B", agentId: "b", peers: [], joinedAt: 0 },
      { sessionKey: "sk:C", agentId: "c", peers: [], joinedAt: 0 },
    ];
    const peerMap = computePeers(members, "mesh");
    expect(peerMap.get("sk:A")).toContain("sk:B");
    expect(peerMap.get("sk:A")).toContain("sk:C");
    expect(peerMap.get("sk:B")).toContain("sk:A");
    expect(peerMap.get("sk:B")).toContain("sk:C");
    expect(peerMap.get("sk:C")).not.toContain("sk:C");
  });

  it("computes hierarchical peers (leader + adjacent)", () => {
    const members = [
      { sessionKey: "leader", agentId: "l", peers: [], joinedAt: 0 },
      { sessionKey: "worker1", agentId: "w1", peers: [], joinedAt: 0 },
      { sessionKey: "worker2", agentId: "w2", peers: [], joinedAt: 0 },
    ];
    const peerMap = computePeers(members, "hierarchical");
    // Leader connects to all workers
    expect(peerMap.get("leader")).toContain("worker1");
    expect(peerMap.get("leader")).toContain("worker2");
    // Worker1 connects to leader + worker2
    expect(peerMap.get("worker1")).toContain("leader");
  });

  it("computes ring peers (next + prev)", () => {
    const members = [
      { sessionKey: "A", agentId: "a", peers: [], joinedAt: 0 },
      { sessionKey: "B", agentId: "b", peers: [], joinedAt: 0 },
      { sessionKey: "C", agentId: "c", peers: [], joinedAt: 0 },
    ];
    const peerMap = computePeers(members, "ring");
    // A connects to B (next) and C (prev in ring)
    expect(peerMap.get("A")).toContain("B");
    expect(peerMap.get("A")).toContain("C");
    // B connects to A and C
    expect(peerMap.get("B")).toContain("A");
    expect(peerMap.get("B")).toContain("C");
  });

  it("removes member and recomputes peers", () => {
    const swarm = createSwarm({ topology: "mesh" });
    addMember(swarm.swarmId, { sessionKey: "sk:A", agentId: "a" });
    addMember(swarm.swarmId, { sessionKey: "sk:B", agentId: "b" });
    addMember(swarm.swarmId, { sessionKey: "sk:C", agentId: "c" });

    removeMember(swarm.swarmId, "sk:A");
    const updatedSwarm = getSwarm(swarm.swarmId);
    expect(updatedSwarm?.members).toHaveLength(2);
    const peersB = getMemberPeers(swarm.swarmId, "sk:B");
    expect(peersB).not.toContain("sk:A");
  });

  it("builds swarm context prompt", () => {
    const prompt = buildSwarmContextPrompt({
      swarmId: "test-swarm-id",
      topology: "mesh",
      sessionKey: "agent:main:subagent:X",
      peers: ["agent:main:subagent:Y", "agent:main:subagent:Z"],
      role: "researcher",
      consensus: "raft",
    });
    expect(prompt).toContain("mesh");
    expect(prompt).toContain("test-swarm-id");
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("agent:main:subagent:Y");
    expect(prompt).toContain("sessions_send");
  });

  it("lists and deletes swarms", () => {
    const s1 = createSwarm({ topology: "mesh" });
    const s2 = createSwarm({ topology: "ring" });
    expect(listSwarms()).toHaveLength(2);
    deleteSwarm(s1.swarmId);
    expect(listSwarms()).toHaveLength(1);
    expect(listSwarms()[0]?.swarmId).toBe(s2.swarmId);
  });
});

// =============================================================================
// CHANNEL BUS TESTS
// =============================================================================

describe("Swarm Channel Bus", () => {
  beforeEach(() => {
    resetSwarmChannelsForTests();
  });

  it("publishes and polls messages", async () => {
    const before = Date.now();
    await swarmChannelPublish({
      channel: "test-channel",
      fromSessionKey: "sk:A",
      fromAgentId: "agent-a",
      payload: { type: "hello", data: 42 },
    });

    const messages = swarmChannelPoll({
      channel: "test-channel",
      requesterSessionKey: "sk:B",
      since: before - 1,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toEqual({ type: "hello", data: 42 });
  });

  it("does not deliver sender's own messages", async () => {
    await swarmChannelPublish({
      channel: "self-test",
      fromSessionKey: "sk:A",
      payload: "hello from A",
    });

    const messages = swarmChannelPoll({
      channel: "self-test",
      requesterSessionKey: "sk:A", // same as sender
    });
    expect(messages).toHaveLength(0);
  });

  it("filters messages by since timestamp", async () => {
    await swarmChannelPublish({ channel: "ts-test", fromSessionKey: "sk:A", payload: "old" });
    await new Promise((r) => setTimeout(r, 5)); // small delay
    const t2 = Date.now();
    await swarmChannelPublish({ channel: "ts-test", fromSessionKey: "sk:B", payload: "new" });

    const onlyNew = swarmChannelPoll({
      channel: "ts-test",
      requesterSessionKey: "sk:C",
      since: t2 - 1,
    });
    expect(onlyNew).toHaveLength(1);
    expect(onlyNew[0]?.payload).toBe("new");
  });

  it("calls handler on publish", async () => {
    let received: unknown = null;
    swarmChannelSubscribe({
      channel: "handler-test",
      sessionKey: "sk:B",
      handler: (msg) => {
        received = msg.payload;
      },
    });

    await swarmChannelPublish({
      channel: "handler-test",
      fromSessionKey: "sk:A",
      payload: { value: "test" },
    });

    expect(received).toEqual({ value: "test" });
  });

  it("lists channels", async () => {
    await swarmChannelPublish({ channel: "ch1", fromSessionKey: "sk:A", payload: 1 });
    await swarmChannelPublish({ channel: "ch2", fromSessionKey: "sk:B", payload: 2 });
    const list = swarmChannelList();
    expect(list.map((c) => c.channel)).toContain("ch1");
    expect(list.map((c) => c.channel)).toContain("ch2");
  });
});

// =============================================================================
// ROUTER TESTS
// =============================================================================

describe("Q-Learning Router", () => {
  it("estimates complexity for simple tasks", () => {
    expect(estimateTaskComplexity("list files")).toBeLessThan(0.3);
    expect(estimateTaskComplexity("hello")).toBeLessThan(0.3);
  });

  it("estimates complexity for complex tasks", () => {
    const complex =
      "Analyze and implement a comprehensive algorithm that optimizes the database query performance using multi-step reasoning and architectural patterns";
    expect(estimateTaskComplexity(complex)).toBeGreaterThan(0.3);
  });

  it("maps complexity to correct tier", () => {
    expect(complexityToTier(0.05)).toBe("t1");
    expect(complexityToTier(0.2)).toBe("t2");
    expect(complexityToTier(0.5)).toBe("t3");
  });

  it("returns routing decision", () => {
    const decision = routeTask({
      task: "Implement a complex distributed system",
      availableModels: ["claude-haiku", "claude-sonnet"],
    });
    expect(decision.tier).toBe("t3");
    expect(decision.complexityScore).toBeGreaterThan(0);
    expect(decision.reasoning).toBeTruthy();
  });

  it("respects forced model", () => {
    const decision = routeTask({
      task: "simple task",
      forceModel: "gpt-4o",
    });
    expect(decision.model).toBe("gpt-4o");
    expect(decision.reasoning).toContain("explicitly specified");
  });

  it("records task outcome and updates Q-table", () => {
    recordTaskOutcome({
      task: "test task for Q learning",
      agentId: "test-agent",
      model: "claude-sonnet",
      outcome: "success",
      durationMs: 5000,
      qualityScore: 0.9,
    });
    const table = serializeQTable();
    expect(Object.keys(table).length).toBeGreaterThan(0);
    // Check positive Q-value for success
    const entry = Object.values(table).find((e) => e.action === "claude-sonnet");
    expect(entry?.value).toBeGreaterThan(0);
  });

  it("serializes and loads Q-table", () => {
    recordTaskOutcome({
      task: "serialization test",
      model: "test-model",
      outcome: "success",
    });
    const snapshot = serializeQTable();
    loadQTableFromData(snapshot);
    const reloaded = serializeQTable();
    expect(reloaded).toEqual(snapshot);
  });
});

// =============================================================================
// CONSENSUS TESTS
// =============================================================================

describe("Swarm Consensus", () => {
  beforeEach(() => {
    resetConsensusForTests();
  });

  it("creates and tallies a majority vote", () => {
    const vote = createVote({
      swarmId: "test-swarm",
      topic: "Which approach?",
      options: ["A", "B", "C"],
      requiredMajority: 0.5,
    });
    castVote({ voteId: vote.voteId, sessionKey: "sk:1", option: "A" });
    castVote({ voteId: vote.voteId, sessionKey: "sk:2", option: "A" });
    castVote({ voteId: vote.voteId, sessionKey: "sk:3", option: "B" });

    const result = tallyVote(vote.voteId);
    expect(result.tally["A"]).toBe(2);
    expect(result.tally["B"]).toBe(1);
    expect(result.totalVotes).toBe(3);
    // A has 2/3 > 0.5, should win
    expect(result.result).toBe("A");
    expect(result.finalized).toBe(true);
  });

  it("rejects invalid vote option", () => {
    const vote = createVote({
      swarmId: "s1",
      topic: "test",
      options: ["yes", "no"],
    });
    const result = castVote({
      voteId: vote.voteId,
      sessionKey: "sk:1",
      option: "maybe",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid option");
  });

  it("raft initializes and handles vote request", () => {
    const state = raftInit("swarm-raft");
    expect(state.term).toBe(0);

    const result = raftRequestVote({
      swarmId: "swarm-raft",
      candidateSessionKey: "sk:candidate",
      term: 1,
    });
    expect(result.granted).toBe(true);
    expect(result.currentTerm).toBe(1);
  });

  it("raft elects a leader", () => {
    raftInit("swarm-leader");
    const state = raftAnnounceLeader({
      swarmId: "swarm-leader",
      leaderId: "sk:leader",
      term: 1,
    });
    expect(state.leaderId).toBe("sk:leader");
    expect(raftIsLeaderAlive("swarm-leader")).toBe(true);
  });

  it("gossip set and get works", () => {
    gossipSet("my-swarm", "key1", { data: "hello" });
    const val = gossipGet("my-swarm", "key1");
    expect(val).toEqual({ data: "hello" });
  });

  it("gossip merge resolves LWW by version", () => {
    gossipSet("swarm-gossip", "x", "local-v1");

    gossipMerge("swarm-gossip", {
      x: { value: "remote-v2", version: 2, ts: Date.now() },
    });

    const val = gossipGet("swarm-gossip", "x");
    expect(val).toBe("remote-v2"); // Higher version wins
  });
});

// =============================================================================
// LEARNING TESTS
// =============================================================================

describe("Swarm Learning Loop", () => {
  beforeEach(() => {
    resetLearningForTests();
  });

  it("computes positive reward for success", () => {
    const reward = computeReward({
      outcome: "success",
      qualityScore: 0.9,
      durationMs: 5000,
    });
    expect(reward).toBeGreaterThan(0.5);
  });

  it("computes negative reward for error", () => {
    const reward = computeReward({ outcome: "error" });
    expect(reward).toBeLessThan(0);
  });

  it("computes negative reward for timeout", () => {
    const reward = computeReward({ outcome: "timeout" });
    expect(reward).toBeLessThan(0);
  });

  it("tracks learning stats after recording", async () => {
    await runLearningLoop({
      taskId: "test-task-1",
      sessionKey: "sk:test",
      agentId: "test-agent",
      model: "claude-sonnet",
      taskDescription: "Implement a feature",
      complexityScore: 0.5,
      tier: "t3",
      startedAt: Date.now() - 5000,
      completedAt: Date.now(),
      durationMs: 5000,
      outcome: "success",
      qualityScore: 0.8,
    });

    const stats = getLearningStats();
    expect(stats.totalTasks).toBe(1);
    expect(stats.successRate).toBe(1.0);
    expect(stats.byTier["t3"]?.count).toBe(1);
  });

  it("gets stats with zero tasks", () => {
    const stats = getLearningStats();
    expect(stats.totalTasks).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.avgReward).toBe(0);
  });
});
