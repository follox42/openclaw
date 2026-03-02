import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { ACP_SPAWN_MODES, spawnAcpDirect } from "../acp-spawn.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import { SWARM_TOPOLOGIES, CONSENSUS_ALGORITHMS } from "../swarm/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  // ─── Swarm Options ──────────────────────────────────────────────────────────
  // Optional swarm integration. When provided, agents are registered in a swarm
  // and receive peer information enabling direct agent↔agent communication.
  topology: Type.Optional(
    Type.Union(
      SWARM_TOPOLOGIES.map((t) => Type.Literal(t)),
      {
        description:
          "Swarm topology: star (default, backward-compat), mesh (P2P), hierarchical (leader+workers), ring (pipeline)",
      },
    ),
  ),
  swarmId: Type.Optional(
    Type.String({
      description: "Join an existing swarm by ID. Creates new swarm if not found.",
    }),
  ),
  swarmRole: Type.Optional(
    Type.String({
      description: "Role for this agent in the swarm (e.g. researcher, coder, analyst)",
    }),
  ),
  consensus: Type.Optional(
    Type.Union(
      CONSENSUS_ALGORITHMS.map((c) => Type.Literal(c)),
      {
        description:
          "Consensus algorithm: none (default), raft (leader election), bft (Byzantine fault-tolerant), gossip, vote",
      },
    ),
  ),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      'Spawn an isolated session (runtime="subagent" or runtime="acp"). mode="run" is one-shot and mode="session" is persistent/thread-bound. ' +
      'Swarm support: set topology="mesh" or topology="hierarchical" with optional swarmId to enable direct agent↔agent communication.',
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;

      // ─── Swarm Options ─────────────────────────────────────────────────────
      const topologyRaw = readStringParam(params, "topology");
      const topology = SWARM_TOPOLOGIES.includes(topologyRaw as (typeof SWARM_TOPOLOGIES)[number])
        ? (topologyRaw as (typeof SWARM_TOPOLOGIES)[number])
        : undefined;
      const swarmId = readStringParam(params, "swarmId") ?? undefined;
      const swarmRole = readStringParam(params, "swarmRole") ?? undefined;
      const consensusRaw = readStringParam(params, "consensus");
      const consensus = CONSENSUS_ALGORITHMS.includes(
        consensusRaw as (typeof CONSENSUS_ALGORITHMS)[number],
      )
        ? (consensusRaw as (typeof CONSENSUS_ALGORITHMS)[number])
        : undefined;

      // Build swarm options only if any swarm param is provided
      const swarmOptions =
        topology || swarmId || swarmRole || consensus
          ? { topology, swarmId, role: swarmRole, consensus }
          : undefined;

      const result =
        runtime === "acp"
          ? await spawnAcpDirect(
              {
                task,
                label: label || undefined,
                agentId: requestedAgentId,
                cwd,
                mode: mode && ACP_SPAWN_MODES.includes(mode) ? mode : undefined,
                thread,
              },
              {
                agentSessionKey: opts?.agentSessionKey,
                agentChannel: opts?.agentChannel,
                agentAccountId: opts?.agentAccountId,
                agentTo: opts?.agentTo,
                agentThreadId: opts?.agentThreadId,
              },
            )
          : await spawnSubagentDirect(
              {
                task,
                label: label || undefined,
                agentId: requestedAgentId,
                model: modelOverride,
                thinking: thinkingOverrideRaw,
                runTimeoutSeconds,
                thread,
                mode,
                cleanup,
                expectsCompletionMessage: true,
                swarm: swarmOptions,
              },
              {
                agentSessionKey: opts?.agentSessionKey,
                agentChannel: opts?.agentChannel,
                agentAccountId: opts?.agentAccountId,
                agentTo: opts?.agentTo,
                agentThreadId: opts?.agentThreadId,
                agentGroupId: opts?.agentGroupId,
                agentGroupChannel: opts?.agentGroupChannel,
                agentGroupSpace: opts?.agentGroupSpace,
                requesterAgentIdOverride: opts?.requesterAgentIdOverride,
              },
            );

      return jsonResult(result);
    },
  };
}
