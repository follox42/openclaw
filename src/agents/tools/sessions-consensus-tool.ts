/**
 * Sessions Consensus Tool
 * Exposes swarm consensus mechanisms to agents.
 *
 * Actions:
 *   create  — Create a new vote/consensus round
 *   vote    — Cast a vote
 *   tally   — Get current results
 *   raft_*  — Raft leader election operations
 *   gossip_set/get — Gossip state sharing
 */

import { Type } from "@sinclair/typebox";
import {
  createVote,
  castVote,
  tallyVote,
  getVote,
  raftInit,
  raftRequestVote,
  raftAnnounceLeader,
  raftHeartbeat,
  raftIsLeaderAlive,
  raftGetState,
  gossipSet,
  gossipGet,
  gossipMerge,
  gossipGetAll,
} from "../swarm/consensus.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ACTION_TYPES = [
  "vote_create",
  "vote_cast",
  "vote_tally",
  "vote_get",
  "raft_init",
  "raft_request_vote",
  "raft_announce_leader",
  "raft_heartbeat",
  "raft_status",
  "gossip_set",
  "gossip_get",
  "gossip_merge",
  "gossip_all",
] as const;

const SessionsConsensusSchema = Type.Object({
  action: Type.String({ description: `Consensus action: ${ACTION_TYPES.join(", ")}` }),
  swarmId: Type.String({ description: "Swarm ID to operate on" }),
  // Vote params
  voteId: Type.Optional(Type.String()),
  topic: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  option: Type.Optional(Type.String()),
  requiredMajority: Type.Optional(Type.Number({ minimum: 0.5, maximum: 1 })),
  ttlMs: Type.Optional(Type.Number({ minimum: 1000 })),
  // Raft params
  candidateSessionKey: Type.Optional(Type.String()),
  term: Type.Optional(Type.Number({ minimum: 0 })),
  leaderId: Type.Optional(Type.String()),
  memberCount: Type.Optional(Type.Number({ minimum: 1 })),
  // Gossip params
  key: Type.Optional(Type.String()),
  value: Type.Optional(Type.Unknown()),
  incoming: Type.Optional(Type.Unknown()),
});

export function createSessionsConsensusTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Swarm Consensus",
    name: "sessions_consensus",
    description:
      "Swarm consensus operations: majority voting, Raft leader election, gossip state sharing. Use for collective decisions in multi-agent swarms.",
    parameters: SessionsConsensusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const swarmId = readStringParam(params, "swarmId", { required: true });

      if (!action || !swarmId) {
        return jsonResult({ status: "error", error: "action and swarmId are required" });
      }

      try {
        switch (action) {
          // ─── Vote ─────────────────────────────────────────────────────────
          case "vote_create": {
            const topic = readStringParam(params, "topic");
            const options = Array.isArray(params.options) ? (params.options as string[]) : [];
            if (!topic || options.length === 0) {
              return jsonResult({
                status: "error",
                error: "vote_create requires topic and options[]",
              });
            }
            const vote = createVote({
              swarmId,
              topic,
              options,
              requiredMajority:
                typeof params.requiredMajority === "number" ? params.requiredMajority : 0.5,
              ttlMs: typeof params.ttlMs === "number" ? params.ttlMs : 60_000,
            });
            return jsonResult({ status: "ok", vote });
          }

          case "vote_cast": {
            const voteId = readStringParam(params, "voteId");
            const option = readStringParam(params, "option");
            if (!voteId || !option) {
              return jsonResult({ status: "error", error: "vote_cast requires voteId and option" });
            }
            const result = castVote({
              voteId,
              sessionKey: opts?.agentSessionKey ?? "unknown",
              option,
            });
            return jsonResult(
              result.ok
                ? { status: "ok", vote: result.vote }
                : { status: "error", error: result.error },
            );
          }

          case "vote_tally": {
            const voteId = readStringParam(params, "voteId");
            if (!voteId) {
              return jsonResult({ status: "error", error: "vote_tally requires voteId" });
            }
            const tally = tallyVote(voteId);
            return jsonResult({ status: "ok", ...tally });
          }

          case "vote_get": {
            const voteId = readStringParam(params, "voteId");
            if (!voteId) {
              return jsonResult({ status: "error", error: "vote_get requires voteId" });
            }
            const vote = getVote(voteId);
            return jsonResult(
              vote ? { status: "ok", vote } : { status: "error", error: "Vote not found" },
            );
          }

          // ─── Raft ──────────────────────────────────────────────────────────
          case "raft_init": {
            const state = raftInit(swarmId);
            return jsonResult({ status: "ok", state });
          }

          case "raft_request_vote": {
            const candidateSessionKey =
              readStringParam(params, "candidateSessionKey") ?? opts?.agentSessionKey ?? "unknown";
            const term = typeof params.term === "number" ? params.term : 1;
            const result = raftRequestVote({ swarmId, candidateSessionKey, term });
            return jsonResult({ status: "ok", ...result });
          }

          case "raft_announce_leader": {
            const leaderId =
              readStringParam(params, "leaderId") ?? opts?.agentSessionKey ?? "unknown";
            const term = typeof params.term === "number" ? params.term : 1;
            const state = raftAnnounceLeader({ swarmId, leaderId, term });
            return jsonResult({ status: "ok", state });
          }

          case "raft_heartbeat": {
            const leaderId =
              readStringParam(params, "leaderId") ?? opts?.agentSessionKey ?? "unknown";
            const ok = raftHeartbeat(swarmId, leaderId);
            return jsonResult({
              status: ok ? "ok" : "error",
              error: ok ? undefined : "Not leader or swarm not found",
            });
          }

          case "raft_status": {
            const state = raftGetState(swarmId);
            const alive = raftIsLeaderAlive(swarmId);
            return jsonResult({
              status: "ok",
              state,
              leaderAlive: alive,
            });
          }

          // ─── Gossip ────────────────────────────────────────────────────────
          case "gossip_set": {
            const key = readStringParam(params, "key");
            if (!key) {
              return jsonResult({ status: "error", error: "gossip_set requires key" });
            }
            gossipSet(swarmId, key, params.value);
            return jsonResult({ status: "ok", key, swarmId });
          }

          case "gossip_get": {
            const key = readStringParam(params, "key");
            if (!key) {
              return jsonResult({ status: "error", error: "gossip_get requires key" });
            }
            const value = gossipGet(swarmId, key);
            return jsonResult({ status: "ok", key, value, swarmId });
          }

          case "gossip_merge": {
            const incoming = params.incoming;
            if (!incoming || typeof incoming !== "object") {
              return jsonResult({
                status: "error",
                error: "gossip_merge requires incoming object",
              });
            }
            gossipMerge(
              swarmId,
              incoming as Record<string, { value: unknown; version: number; ts: number }>,
            );
            return jsonResult({ status: "ok", swarmId });
          }

          case "gossip_all": {
            const all = gossipGetAll(swarmId);
            return jsonResult({ status: "ok", swarmId, state: all });
          }

          default:
            return jsonResult({
              status: "error",
              error: `Unknown consensus action: ${action}. Valid: ${ACTION_TYPES.join(", ")}`,
            });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({ status: "error", error: msg });
      }
    },
  };
}
