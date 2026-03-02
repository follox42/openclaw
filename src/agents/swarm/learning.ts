/**
 * Swarm Learning Loop
 * Post-task learning: evaluates results, extracts patterns, updates routing.
 *
 * Loop: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE → ROUTE
 *
 * Persistence: KB Outline via kb_write API calls through gateway.
 * Q-values updated via router.updateQValue().
 */

import { callGateway } from "../../gateway/call.js";
import { recordTaskOutcome, serializeQTable, loadQTableFromData } from "./router.js";
import type { TaskMetrics } from "./types.js";

// ─── In-Memory Task History ───────────────────────────────────────────────────

const taskHistory: TaskMetrics[] = [];
const MAX_HISTORY = 500;

// ─── Reward Computation ───────────────────────────────────────────────────────

/**
 * Compute composite reward from task metrics.
 * Components: success (40%), quality (30%), latency (20%), cost proxy (10%)
 */
export function computeReward(metrics: Partial<TaskMetrics>): number {
  let reward = 0;

  if (metrics.outcome === "success") {
    reward += 0.4;
    if (typeof metrics.qualityScore === "number") {
      reward += Math.max(0, Math.min(1, metrics.qualityScore)) * 0.3;
    }
    if (typeof metrics.durationMs === "number" && metrics.durationMs > 0) {
      // Latency: exponential decay, 30s = 0.5 score
      const latencyScore = Math.exp(-metrics.durationMs / 30000);
      reward += latencyScore * 0.2;
    }
    reward += 0.1; // Baseline cost bonus
  } else if (metrics.outcome === "error") {
    reward = -0.3;
  } else if (metrics.outcome === "timeout") {
    reward = -0.2;
  } else if (metrics.outcome === "killed") {
    reward = -0.1;
  }

  return Math.max(-1, Math.min(1, reward));
}

// ─── Learning Entry Point ─────────────────────────────────────────────────────

/**
 * Main learning loop hook — called after every subagent completes.
 * Asynchronous, non-blocking (failures don't affect main flow).
 */
export async function runLearningLoop(metrics: TaskMetrics): Promise<void> {
  // 1. RETRIEVE — add to local history
  taskHistory.push(metrics);
  if (taskHistory.length > MAX_HISTORY) {
    taskHistory.splice(0, taskHistory.length - MAX_HISTORY);
  }

  // 2. JUDGE — compute reward
  const reward = computeReward(metrics);
  const updatedMetrics = { ...metrics, reward };

  // 3. DISTILL — update Q-table
  recordTaskOutcome({
    task: metrics.taskDescription,
    agentId: metrics.agentId,
    model: metrics.model,
    outcome: metrics.outcome,
    durationMs: metrics.durationMs,
    qualityScore: metrics.qualityScore,
  });

  // 4. CONSOLIDATE — persist to KB (best effort)
  void persistLearningToKB(updatedMetrics).catch(() => {
    // KB persistence failures are non-fatal
  });
}

/**
 * Persist learning data to KB Outline for long-term retention.
 */
async function persistLearningToKB(metrics: TaskMetrics): Promise<void> {
  const timestamp = new Date(metrics.startedAt).toISOString();
  const docTitle = `[swarm/learning/${metrics.taskId}] task-outcome`;
  const content = [
    `# Task Learning Record`,
    ``,
    `**ID**: ${metrics.taskId}`,
    `**Timestamp**: ${timestamp}`,
    `**Agent**: ${metrics.agentId}`,
    `**Session**: ${metrics.sessionKey}`,
    `**Model**: ${metrics.model ?? "default"}`,
    `**Tier**: ${metrics.tier}`,
    `**Outcome**: ${metrics.outcome}`,
    `**Duration**: ${metrics.durationMs ? `${(metrics.durationMs / 1000).toFixed(1)}s` : "unknown"}`,
    `**Reward**: ${metrics.reward?.toFixed(3) ?? "N/A"}`,
    `**Quality**: ${metrics.qualityScore?.toFixed(2) ?? "N/A"}`,
    ``,
    `## Task`,
    `\`\`\``,
    metrics.taskDescription.slice(0, 500),
    `\`\`\``,
    ``,
    `## Q-Table Snapshot`,
    `\`\`\`json`,
    JSON.stringify(serializeQTable(), null, 2),
    `\`\`\``,
  ].join("\n");

  try {
    await callGateway({
      method: "kb.write",
      params: { title: docTitle, content },
      timeoutMs: 5_000,
    });
  } catch {
    // KB write unavailable in this context — use local file fallback
    await persistLearningToFile(metrics).catch(() => {});
  }
}

/**
 * File-based fallback for learning persistence.
 */
async function persistLearningToFile(metrics: TaskMetrics): Promise<void> {
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const dir = join(homedir(), ".openclaw", "swarm-learning");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }
  }

  const filePath = join(dir, `${metrics.taskId}.json`);
  try {
    writeFileSync(filePath, JSON.stringify(metrics, null, 2), "utf-8");
  } catch {
    // Best effort
  }

  // Also persist Q-table snapshot
  const qtablePath = join(dir, "qtable.json");
  try {
    writeFileSync(qtablePath, JSON.stringify(serializeQTable(), null, 2), "utf-8");
  } catch {
    // Best effort
  }
}

/**
 * Load persisted Q-table from file on startup.
 */
export async function loadPersistedQTable(): Promise<void> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const filePath = join(homedir(), ".openclaw", "swarm-learning", "qtable.json");
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      loadQTableFromData(data);
    }
  } catch {
    // Best effort — no existing Q-table is fine
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Get learning statistics.
 */
export function getLearningStats(): {
  totalTasks: number;
  successRate: number;
  avgReward: number;
  avgDurationMs: number;
  byTier: Record<string, { count: number; successRate: number; avgReward: number }>;
} {
  if (taskHistory.length === 0) {
    return {
      totalTasks: 0,
      successRate: 0,
      avgReward: 0,
      avgDurationMs: 0,
      byTier: {},
    };
  }

  const successes = taskHistory.filter((t) => t.outcome === "success").length;
  const rewards = taskHistory.map((t) => t.reward ?? 0);
  const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length;

  const durations = taskHistory.filter((t) => t.durationMs !== undefined).map((t) => t.durationMs!);
  const avgDurationMs =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  const byTier: Record<string, { count: number; successRate: number; avgReward: number }> = {};
  for (const task of taskHistory) {
    const tier = task.tier;
    if (!byTier[tier]) {
      byTier[tier] = { count: 0, successRate: 0, avgReward: 0 };
    }
    byTier[tier].count++;
  }
  for (const tier of Object.keys(byTier)) {
    const tierTasks = taskHistory.filter((t) => t.tier === tier);
    const tierSuccesses = tierTasks.filter((t) => t.outcome === "success").length;
    const tierRewards = tierTasks.map((t) => t.reward ?? 0);
    byTier[tier].successRate = tierSuccesses / tierTasks.length;
    byTier[tier].avgReward =
      tierRewards.reduce((a, b) => a + b, 0) / Math.max(1, tierRewards.length);
  }

  return {
    totalTasks: taskHistory.length,
    successRate: successes / taskHistory.length,
    avgReward,
    avgDurationMs,
    byTier,
  };
}

/** Reset for tests. */
export function resetLearningForTests(): void {
  taskHistory.length = 0;
}
