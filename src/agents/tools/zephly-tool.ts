/**
 * Zephly Tool — Native OpenClaw integration for Zephly.ai
 *
 * Zephly is an AI workflow automation SaaS. This tool lets agents:
 * - Browse and manage templates (gallery)
 * - Create and execute workflows (nodes + edges DAG)
 * - Poll run status and retrieve artifacts
 * - Save example results to templates
 *
 * Config via env vars:
 *   ZEPHLY_API_URL   (default: https://dev.shosai.fr)
 *   ZEPHLY_EMAIL     (default: admin@zephly.io)
 *   ZEPHLY_PASSWORD  (default: admin123)
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_URL =
  (process.env.ZEPHLY_API_URL ?? "https://dev.shosai.fr").replace(/\/$/, "") + "/v1";
const EMAIL = process.env.ZEPHLY_EMAIL ?? "admin@zephly.io";
const PASSWORD = process.env.ZEPHLY_PASSWORD ?? "admin123";

// ─── Token cache ──────────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0; // unix ms

async function getToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 60_000) {
    return _cachedToken;
  }
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zephly login failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  _cachedToken = data.access_token;
  // Default token lifetime: 24h
  _tokenExpiresAt = now + (data.expires_in ?? 86_400) * 1_000;
  return _cachedToken;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const RETRY_CODES = new Set([429, 503]);
const MAX_RETRIES = 3;

async function zephlyFetch(
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<unknown> {
  const token = await getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (RETRY_CODES.has(res.status) && attempt < MAX_RETRIES) {
    const delay = 2 ** attempt * 2_000; // 2s, 4s, 8s
    await new Promise((r) => setTimeout(r, delay));
    return zephlyFetch(method, path, body, attempt + 1);
  }

  if (res.status === 401) {
    // Token expired — force refresh once
    _cachedToken = null;
    if (attempt === 0) return zephlyFetch(method, path, body, 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zephly API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

const api = {
  get: (path: string) => zephlyFetch("GET", path),
  post: (path: string, body?: unknown) => zephlyFetch("POST", path, body),
  put: (path: string, body?: unknown) => zephlyFetch("PUT", path, body),
  del: (path: string) => zephlyFetch("DELETE", path),
};

// ─── Poll helper ──────────────────────────────────────────────────────────────

type RunStatus = {
  status: "pending" | "running" | "completed" | "partial_success" | "failed" | "cancelled";
  run_id: string;
  nodes_total?: number;
  nodes_completed?: number;
  nodes_failed?: number;
  error?: string;
};

async function pollUntilDone(
  runId: string,
  intervalMs = 15_000,
  timeoutMs = 300_000,
): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (await api.get(`/workflows/execution/${runId}`)) as RunStatus;
    if (
      status.status === "completed" ||
      status.status === "partial_success" ||
      status.status === "failed" ||
      status.status === "cancelled"
    ) {
      return status;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Workflow run ${runId} timed out after ${timeoutMs / 1000}s`);
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const ZEPHLY_ACTIONS = [
  "auth",
  "list_templates",
  "get_template",
  "list_workflows",
  "get_workflow",
  "run_workflow",
  "retry_node",
  "save_examples",
  "get_artifact",
  "create_template",
] as const;

type ZephlyAction = (typeof ZEPHLY_ACTIONS)[number];

const ZephlySchema = Type.Object({
  action: Type.Union(ZEPHLY_ACTIONS.map((a) => Type.Literal(a)), {
    description: [
      "Zephly action to perform:",
      "  • auth            — test login + return token info",
      "  • list_templates  — paginated public template gallery",
      "  • get_template(id) — full template details + example_results",
      "  • list_workflows  — list user workflows",
      "  • get_workflow(id) — workflow details with nodes + edges",
      "  • run_workflow(workflow_id) — execute workflow, poll to completion, return artifacts",
      "  • retry_node(run_id, node_id) — re-run a specific failed node",
      "  • save_examples(template_id, run_id) — save run artifacts as template examples",
      "  • get_artifact(artifact_id) — artifact metadata + URL",
      "  • create_template(name, description, workflow_id) — publish workflow as template",
    ].join("\n"),
  }),

  // ─── Shared params ────────────────────────────────────────────────────────
  id: Type.Optional(
    Type.Number({
      description: "Template or workflow integer ID. Used by: get_template, get_workflow.",
    }),
  ),
  template_id: Type.Optional(
    Type.Number({
      description: "Template ID. Used by: get_template, save_examples, create_template.",
    }),
  ),
  workflow_id: Type.Optional(
    Type.Number({
      description:
        "Workflow ID. Used by: get_workflow, run_workflow, create_template (source workflow).",
    }),
  ),
  run_id: Type.Optional(
    Type.String({
      description: "Workflow run UUID. Used by: retry_node, save_examples.",
    }),
  ),
  node_id: Type.Optional(
    Type.String({
      description: "Node UUID within the workflow graph. Used by: retry_node.",
    }),
  ),
  artifact_id: Type.Optional(
    Type.Number({
      description: "Artifact integer ID. Used by: get_artifact.",
    }),
  ),

  // ─── run_workflow params ──────────────────────────────────────────────────
  inputs: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Initial inputs for the workflow run (JSON object). Used by: run_workflow. " +
        "Example: { 'node_id': { 'text': 'hello' } }",
    }),
  ),
  poll_interval_ms: Type.Optional(
    Type.Number({
      description: "Poll interval in ms for run_workflow. Default: 15000.",
      minimum: 3000,
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Timeout in ms for run_workflow. Default: 300000 (5 min).",
      minimum: 10000,
    }),
  ),

  // ─── list params ─────────────────────────────────────────────────────────
  limit: Type.Optional(
    Type.Number({
      description: "Max results. Default 20. Used by: list_templates, list_workflows.",
      minimum: 1,
      maximum: 100,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: "Pagination offset. Used by: list_templates.",
      minimum: 0,
    }),
  ),
  category: Type.Optional(
    Type.String({
      description:
        "Filter by category. Used by: list_templates. " +
        "Values: ugc, marketing, ecommerce, content_creation, video.",
    }),
  ),
  search: Type.Optional(
    Type.String({
      description: "Search query. Used by: list_templates.",
    }),
  ),

  // ─── create_template params ───────────────────────────────────────────────
  name: Type.Optional(
    Type.String({
      description: "Template name. Used by: create_template.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Template description. Used by: create_template.",
    }),
  ),
  visibility: Type.Optional(
    Type.String({
      description:
        'Template visibility. Used by: create_template. Values: "public", "unlisted", "private". Default: "public".',
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Template tags/categories. Used by: create_template.",
    }),
  ),
});

// ─── Action implementations ───────────────────────────────────────────────────

async function doAuth() {
  _cachedToken = null; // force fresh login
  const token = await getToken();
  return {
    ok: true,
    api_url: API_URL,
    email: EMAIL,
    token_preview: token.slice(0, 20) + "…",
    expires_at: new Date(_tokenExpiresAt).toISOString(),
  };
}

async function doListTemplates(params: Record<string, unknown>) {
  const limit = readNumberParam(params, "limit") ?? 20;
  const offset = readNumberParam(params, "offset") ?? 0;
  const category = readStringParam(params, "category");
  const search = readStringParam(params, "search");

  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (category) qs.set("category", category);
  if (search) qs.set("search", search);

  return api.get(`/templates?${qs}`);
}

async function doGetTemplate(params: Record<string, unknown>) {
  const id = readNumberParam(params, "id") ?? readNumberParam(params, "template_id");
  if (!id) throw new Error('get_template requires "id" or "template_id"');
  return api.get(`/templates/${id}`);
}

async function doListWorkflows(params: Record<string, unknown>) {
  const limit = readNumberParam(params, "limit") ?? 20;
  return api.get(`/workflows?limit=${limit}`);
}

async function doGetWorkflow(params: Record<string, unknown>) {
  const id = readNumberParam(params, "id") ?? readNumberParam(params, "workflow_id");
  if (!id) throw new Error('get_workflow requires "id" or "workflow_id"');
  return api.get(`/workflows/${id}`);
}

async function doRunWorkflow(params: Record<string, unknown>) {
  const workflowId = readNumberParam(params, "workflow_id");
  if (!workflowId) throw new Error('run_workflow requires "workflow_id"');

  const inputs = (params.inputs as Record<string, unknown>) ?? {};
  const intervalMs = readNumberParam(params, "poll_interval_ms") ?? 15_000;
  const timeoutMs = readNumberParam(params, "timeout_ms") ?? 300_000;

  // Start execution
  const startResp = (await api.post(`/workflows/${workflowId}/execute`, {
    initial_input: inputs,
  })) as { run_id: string; status: string };

  const runId = startResp.run_id;

  // Poll until done
  const finalStatus = await pollUntilDone(runId, intervalMs, timeoutMs);

  // Fetch artifacts from the run
  let artifacts: unknown[] = [];
  try {
    artifacts = (await api.get(`/artifacts/run/${runId}`)) as unknown[];
  } catch {
    // Non-fatal — artifacts may not exist yet
  }

  // Fetch full execution state for node outputs
  let executionState: unknown = null;
  try {
    executionState = await api.get(`/workflows/execution/${runId}/state`);
  } catch {
    // Non-fatal
  }

  return {
    ok: finalStatus.status !== "failed",
    run_id: runId,
    workflow_id: workflowId,
    status: finalStatus.status,
    nodes_total: finalStatus.nodes_total,
    nodes_completed: finalStatus.nodes_completed,
    nodes_failed: finalStatus.nodes_failed,
    error: finalStatus.error,
    artifacts_count: Array.isArray(artifacts) ? artifacts.length : 0,
    artifacts,
    execution_state: executionState,
  };
}

async function doRetryNode(params: Record<string, unknown>) {
  const runId = readStringParam(params, "run_id");
  const nodeId = readStringParam(params, "node_id");
  if (!runId) throw new Error('retry_node requires "run_id"');
  if (!nodeId) throw new Error('retry_node requires "node_id"');

  // Get execution state to find workflow_id
  const state = (await api.get(`/workflows/execution/${runId}/state`)) as {
    workflow_id: number;
  };
  const workflowId = state.workflow_id;

  // Execute single node
  const result = await api.post(`/workflows/${workflowId}/execute/node`, {
    node_id: nodeId,
    input_data: {},
  });

  return { ok: true, workflow_id: workflowId, node_id: nodeId, ...((result as object) ?? {}) };
}

async function doSaveExamples(params: Record<string, unknown>) {
  const templateId = readNumberParam(params, "template_id");
  const runId = readStringParam(params, "run_id");
  if (!templateId) throw new Error('save_examples requires "template_id"');
  if (!runId) throw new Error('save_examples requires "run_id"');

  return api.post(`/templates/${templateId}/save-examples`, { run_id: runId });
}

async function doGetArtifact(params: Record<string, unknown>) {
  const artifactId = readNumberParam(params, "artifact_id");
  if (!artifactId) throw new Error('get_artifact requires "artifact_id"');
  return api.get(`/artifacts/${artifactId}`);
}

async function doCreateTemplate(params: Record<string, unknown>) {
  const workflowId = readNumberParam(params, "workflow_id");
  const name = readStringParam(params, "name");
  const description = readStringParam(params, "description") ?? "";
  const visibility = readStringParam(params, "visibility") ?? "public";

  if (!workflowId) throw new Error('create_template requires "workflow_id"');
  if (!name) throw new Error('create_template requires "name"');

  // Fetch the workflow to get its graph_json
  const workflow = (await api.get(`/workflows/${workflowId}`)) as {
    graph: unknown;
    name: string;
    description?: string;
  };

  return api.post("/templates", {
    name,
    description,
    workflow_json: workflow.graph,
    visibility,
    category: "ugc",
    example_results: [],
    template_metadata: {
      source_workflow_id: workflowId,
      tags: params.tags ?? [],
    },
  });
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createZephlyTool(): AnyAgentTool {
  return {
    label: "Zephly",
    name: "zephly",
    description: [
      "Interact with Zephly.ai — an AI workflow automation SaaS.",
      "Build and run visual AI pipelines: Claude, Gemini, DALL-E, NanoBanana (Gemini image), ElevenLabs, etc.",
      "Use for: managing templates, creating/running workflows, retrieving artifacts,",
      "saving example results, and publishing templates to the gallery.",
      "Triggers on: zephly, workflow automation, template, run workflow, AI pipeline,",
      "generate images with workflow, product photo studio, save examples.",
    ].join(" "),
    parameters: ZephlySchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawAction = readStringParam(params, "action", { required: true });
      const action = rawAction as ZephlyAction;

      if (!ZEPHLY_ACTIONS.includes(action)) {
        return jsonResult({
          error: "invalid_action",
          message: `Unknown action "${action}". Valid: ${ZEPHLY_ACTIONS.join(", ")}`,
        });
      }

      const start = Date.now();
      try {
        let result: unknown;

        switch (action) {
          case "auth":
            result = await doAuth();
            break;
          case "list_templates":
            result = await doListTemplates(params);
            break;
          case "get_template":
            result = await doGetTemplate(params);
            break;
          case "list_workflows":
            result = await doListWorkflows(params);
            break;
          case "get_workflow":
            result = await doGetWorkflow(params);
            break;
          case "run_workflow":
            result = await doRunWorkflow(params);
            break;
          case "retry_node":
            result = await doRetryNode(params);
            break;
          case "save_examples":
            result = await doSaveExamples(params);
            break;
          case "get_artifact":
            result = await doGetArtifact(params);
            break;
          case "create_template":
            result = await doCreateTemplate(params);
            break;
        }

        const tookMs = Date.now() - start;
        const payload =
          typeof result === "object" && result !== null
            ? { ...(result as Record<string, unknown>), _tookMs: tookMs }
            : result;

        return jsonResult(payload);
      } catch (err) {
        const tookMs = Date.now() - start;
        return jsonResult({
          ok: false,
          error: "zephly_error",
          message: err instanceof Error ? err.message : String(err),
          action,
          _tookMs: tookMs,
        });
      }
    },
  };
}
