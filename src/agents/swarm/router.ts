/**
 * Swarm Q-Learning Router
 * Selects the optimal model/tier for a task based on complexity analysis and
 * Q-Learning history stored in KB Outline.
 *
 * Tiers:
 *   T1: complexity < 0.1 → direct/no-LLM or fast model
 *   T2: complexity < 0.3 → balanced model (haiku/flash)
 *   T3: complexity >= 0.3 → powerful model (sonnet/opus)
 *
 * Q-values are persisted in KB Outline under namespace "swarm/routing".
 * Epsilon-greedy exploration: ε = 0.1 (10% random, 90% exploit).
 */

import type { QTableEntry, RoutingDecision, RoutingTier } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const EPSILON = 0.1; // Exploration rate
const LEARNING_RATE = 0.1; // α
const DISCOUNT_FACTOR = 0.9; // γ
const COMPLEXITY_T1 = 0.1;
const COMPLEXITY_T2 = 0.3;

// In-memory Q-table cache
const qTableCache = new Map<string, QTableEntry>();

// ─── Complexity Estimation ────────────────────────────────────────────────────

const COMPLEXITY_KEYWORDS_HIGH = [
  "analyze",
  "analyse",
  "implement",
  "architect",
  "design",
  "optimize",
  "refactor",
  "debug",
  "solve",
  "reason",
  "compare",
  "evaluate",
  "research",
  "strategy",
  "plan",
  "complex",
  "multi-step",
  "algorithm",
];

const COMPLEXITY_KEYWORDS_LOW = [
  "list",
  "show",
  "print",
  "format",
  "convert",
  "simple",
  "basic",
  "quick",
  "hello",
  "ping",
  "status",
  "check",
];

/**
 * Estimate task complexity score [0, 1] based on content heuristics.
 */
export function estimateTaskComplexity(task: string): number {
  const lower = task.toLowerCase();
  const words = lower.split(/\s+/).length;

  let score = 0.2; // baseline

  // Length factor
  if (words > 100) {
    score += 0.3;
  } else if (words > 50) {
    score += 0.2;
  } else if (words > 20) {
    score += 0.1;
  }

  // Keyword factors
  for (const kw of COMPLEXITY_KEYWORDS_HIGH) {
    if (lower.includes(kw)) {
      score += 0.05;
    }
  }
  for (const kw of COMPLEXITY_KEYWORDS_LOW) {
    if (lower.includes(kw)) {
      score -= 0.05;
    }
  }

  // Structural complexity
  if (lower.includes("step") || lower.includes("then")) {
    score += 0.05;
  }
  if (lower.includes("```") || lower.includes("code")) {
    score += 0.1;
  }
  if (lower.includes("?") && words < 10) {
    score -= 0.05;
  } // Simple question

  return Math.max(0, Math.min(1, score));
}

/**
 * Map complexity score to routing tier.
 */
export function complexityToTier(score: number): RoutingTier {
  if (score < COMPLEXITY_T1) {
    return "t1";
  }
  if (score < COMPLEXITY_T2) {
    return "t2";
  }
  return "t3";
}

// ─── Q-Table State ────────────────────────────────────────────────────────────

function makeStateKey(task: string, agentId?: string): string {
  const complexity = estimateTaskComplexity(task);
  const tier = complexityToTier(complexity);
  const prefix = agentId ? `${agentId}:` : "";
  return `${prefix}${tier}`;
}

function makeActionKey(model?: string): string {
  return model ?? "default";
}

/**
 * Get Q-value for a (state, action) pair from cache.
 */
function getQValue(state: string, action: string): number {
  const key = `${state}:${action}`;
  return qTableCache.get(key)?.value ?? 0;
}

/**
 * Update Q-value using Bellman equation.
 */
export function updateQValue(params: {
  state: string;
  action: string;
  reward: number;
  nextState?: string;
}): void {
  const { state, action, reward, nextState } = params;
  const key = `${state}:${action}`;
  const current = qTableCache.get(key) ?? {
    state,
    action,
    value: 0,
    visits: 0,
    lastUpdated: Date.now(),
  };

  const maxNextQ = nextState
    ? Math.max(
        ...Array.from(qTableCache.values())
          .filter((e) => e.state === nextState)
          .map((e) => e.value),
        0,
      )
    : 0;

  const newValue =
    current.value + LEARNING_RATE * (reward + DISCOUNT_FACTOR * maxNextQ - current.value);

  qTableCache.set(key, {
    state,
    action,
    value: newValue,
    visits: current.visits + 1,
    lastUpdated: Date.now(),
  });
}

// ─── KB Persistence Helpers ──────────────────────────────────────────────────

/** Load Q-table snapshot from KB (called on startup or cache miss). */
export async function loadQTableFromKB(): Promise<void> {
  // KB search for routing Q-values - best effort
  // Q-values are loaded from file via loadPersistedQTable() in learning.ts
  // This is a no-op placeholder for future direct KB integration
  await Promise.resolve();
}

/** Serialize Q-table for KB storage. */
export function serializeQTable(): Record<string, QTableEntry> {
  const result: Record<string, QTableEntry> = {};
  for (const [k, v] of qTableCache) {
    result[k] = v;
  }
  return result;
}

/** Load serialized Q-table into cache. */
export function loadQTableFromData(data: Record<string, QTableEntry>): void {
  for (const [k, v] of Object.entries(data)) {
    qTableCache.set(k, v);
  }
}

// ─── Main Router ─────────────────────────────────────────────────────────────

/**
 * Choose the optimal routing tier and model for a task.
 * Uses epsilon-greedy Q-Learning with task complexity estimation.
 */
export function routeTask(params: {
  task: string;
  agentId?: string;
  availableModels?: string[];
  forceModel?: string;
}): RoutingDecision {
  const { task, agentId, availableModels, forceModel } = params;

  if (forceModel) {
    const complexity = estimateTaskComplexity(task);
    return {
      tier: complexityToTier(complexity),
      model: forceModel,
      reasoning: "model explicitly specified",
      complexityScore: complexity,
    };
  }

  const complexity = estimateTaskComplexity(task);
  const tier = complexityToTier(complexity);
  const state = makeStateKey(task, agentId);

  // Epsilon-greedy: explore vs exploit
  const explore = Math.random() < EPSILON;

  if (explore || !availableModels || availableModels.length === 0) {
    // Exploration: return tier-based default
    return {
      tier,
      model: undefined, // let the system choose default
      reasoning: explore
        ? `exploration (ε=${EPSILON}): random action`
        : "no available models specified",
      complexityScore: complexity,
    };
  }

  // Exploitation: pick model with highest Q-value for this state
  let bestModel: string | undefined;
  let bestQValue = -Infinity;

  for (const model of availableModels) {
    const action = makeActionKey(model);
    const q = getQValue(state, action);
    if (q > bestQValue) {
      bestQValue = q;
      bestModel = model;
    }
  }

  return {
    tier,
    model: bestModel,
    reasoning: `Q-learning: state=${state}, action=${bestModel ?? "default"}, Q=${bestQValue.toFixed(3)}`,
    complexityScore: complexity,
    qValue: bestQValue === -Infinity ? 0 : bestQValue,
  };
}

/**
 * Record task outcome and update Q-table.
 * Call this after a subagent completes.
 */
export function recordTaskOutcome(params: {
  task: string;
  agentId?: string;
  model?: string;
  outcome: "success" | "error" | "timeout" | "killed";
  durationMs?: number;
  qualityScore?: number;
}): { reward: number; stateKey: string; actionKey: string } {
  const { task, agentId, model, outcome, durationMs, qualityScore } = params;

  // Compute reward
  let reward = 0;
  if (outcome === "success") {
    reward += 0.4; // base success reward
    if (qualityScore !== undefined) {
      reward += qualityScore * 0.3; // quality component
    }
    if (durationMs !== undefined) {
      // Latency component: faster is better, normalized to 60s
      const latencyScore = Math.max(0, 1 - durationMs / 60000);
      reward += latencyScore * 0.2;
    }
    reward += 0.1; // cost bonus (no extra cost tracking here, just baseline)
  } else if (outcome === "error") {
    reward = -0.3;
  } else if (outcome === "timeout") {
    reward = -0.2;
  } else if (outcome === "killed") {
    reward = -0.1;
  }

  const stateKey = makeStateKey(task, agentId);
  const actionKey = makeActionKey(model);

  updateQValue({
    state: stateKey,
    action: actionKey,
    reward,
  });

  return { reward, stateKey, actionKey };
}
