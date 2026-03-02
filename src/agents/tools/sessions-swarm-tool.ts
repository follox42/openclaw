/**
 * Sessions Swarm Tool
 * Manage swarm topology: create, join, leave swarms.
 * Get swarm state, list members, get learning stats.
 */

import { Type } from "@sinclair/typebox";
import { getLearningStats } from "../swarm/learning.js";
import { routeTask, estimateTaskComplexity } from "../swarm/router.js";
import {
  createSwarm,
  getSwarm,
  addMember,
  removeMember,
  getMemberPeers,
  listSwarms,
  deleteSwarm,
  buildSwarmContextPrompt,
} from "../swarm/topology.js";
import { SWARM_TOPOLOGIES, CONSENSUS_ALGORITHMS } from "../swarm/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SWARM_ACTIONS = [
  "create",
  "join",
  "leave",
  "status",
  "list",
  "delete",
  "peers",
  "learning_stats",
  "route",
] as const;

const SessionsSwarmSchema = Type.Object({
  action: Type.String({ description: `Swarm action: ${SWARM_ACTIONS.join(", ")}` }),
  swarmId: Type.Optional(Type.String()),
  topology: Type.Optional(Type.Union(SWARM_TOPOLOGIES.map((t) => Type.Literal(t)))),
  consensus: Type.Optional(Type.Union(CONSENSUS_ALGORITHMS.map((c) => Type.Literal(c)))),
  agentId: Type.Optional(Type.String()),
  role: Type.Optional(Type.String({ description: "Role in swarm (e.g. researcher, coder)" })),
  task: Type.Optional(Type.String({ description: "Task to analyze for routing decision" })),
  availableModels: Type.Optional(Type.Array(Type.String())),
});

export function createSessionsSwarmTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Swarm Manager",
    name: "sessions_swarm",
    description:
      "Manage multi-agent swarms: create swarms with topologies (star/mesh/hierarchical/ring), join/leave, view peers, get learning stats, and get routing recommendations for tasks.",
    parameters: SessionsSwarmSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (!action) {
        return jsonResult({ status: "error", error: "action is required" });
      }

      try {
        switch (action) {
          case "create": {
            const topology = SWARM_TOPOLOGIES.includes(
              params.topology as (typeof SWARM_TOPOLOGIES)[number],
            )
              ? (params.topology as (typeof SWARM_TOPOLOGIES)[number])
              : "star";
            const consensus = CONSENSUS_ALGORITHMS.includes(
              params.consensus as (typeof CONSENSUS_ALGORITHMS)[number],
            )
              ? (params.consensus as (typeof CONSENSUS_ALGORITHMS)[number])
              : "none";
            const swarm = createSwarm({ topology, consensus });
            return jsonResult({ status: "ok", swarm });
          }

          case "join": {
            const swarmId = readStringParam(params, "swarmId");
            if (!swarmId) {
              return jsonResult({ status: "error", error: "join requires swarmId" });
            }
            const agentId = readStringParam(params, "agentId") ?? opts?.agentId ?? "unknown";
            const sessionKey = opts?.agentSessionKey ?? "unknown";
            const role = readStringParam(params, "role") ?? undefined;

            const swarm = addMember(swarmId, { sessionKey, agentId, role });
            if (!swarm) {
              return jsonResult({ status: "error", error: `Swarm ${swarmId} not found` });
            }

            const peers = getMemberPeers(swarmId, sessionKey);
            const contextPrompt = buildSwarmContextPrompt({
              swarmId,
              topology: swarm.topology,
              sessionKey,
              peers,
              role,
              consensus: swarm.consensus,
            });

            return jsonResult({
              status: "ok",
              swarmId,
              topology: swarm.topology,
              peers,
              memberCount: swarm.members.length,
              contextPrompt,
              channel: `swarm:${swarmId}`,
            });
          }

          case "leave": {
            const swarmId = readStringParam(params, "swarmId");
            if (!swarmId) {
              return jsonResult({ status: "error", error: "leave requires swarmId" });
            }
            const sessionKey = opts?.agentSessionKey ?? "unknown";
            const swarm = removeMember(swarmId, sessionKey);
            return jsonResult({
              status: "ok",
              swarmId,
              remainingMembers: swarm?.members.length ?? 0,
            });
          }

          case "status": {
            const swarmId = readStringParam(params, "swarmId");
            if (!swarmId) {
              return jsonResult({ status: "error", error: "status requires swarmId" });
            }
            const swarm = getSwarm(swarmId);
            if (!swarm) {
              return jsonResult({ status: "error", error: `Swarm ${swarmId} not found` });
            }
            return jsonResult({ status: "ok", swarm });
          }

          case "list": {
            const swarms = listSwarms();
            return jsonResult({ status: "ok", swarms, count: swarms.length });
          }

          case "delete": {
            const swarmId = readStringParam(params, "swarmId");
            if (!swarmId) {
              return jsonResult({ status: "error", error: "delete requires swarmId" });
            }
            const deleted = deleteSwarm(swarmId);
            return jsonResult({ status: deleted ? "ok" : "error", swarmId });
          }

          case "peers": {
            const swarmId = readStringParam(params, "swarmId");
            if (!swarmId) {
              return jsonResult({ status: "error", error: "peers requires swarmId" });
            }
            const sessionKey = opts?.agentSessionKey ?? "unknown";
            const peers = getMemberPeers(swarmId, sessionKey);
            return jsonResult({ status: "ok", swarmId, sessionKey, peers });
          }

          case "learning_stats": {
            const stats = getLearningStats();
            return jsonResult({ status: "ok", stats });
          }

          case "route": {
            const task = readStringParam(params, "task");
            if (!task) {
              return jsonResult({ status: "error", error: "route requires task" });
            }
            const availableModels = Array.isArray(params.availableModels)
              ? (params.availableModels as string[])
              : undefined;
            const complexity = estimateTaskComplexity(task);
            const decision = routeTask({
              task,
              agentId: opts?.agentId,
              availableModels,
            });
            return jsonResult({
              status: "ok",
              complexity,
              decision,
            });
          }

          default:
            return jsonResult({
              status: "error",
              error: `Unknown action: ${action}. Valid: ${SWARM_ACTIONS.join(", ")}`,
            });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({ status: "error", error: msg });
      }
    },
  };
}
