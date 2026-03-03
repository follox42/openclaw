import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// ─── Script resolution ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolves the Python core script path relative to this TS file. */
function resolveScriptPath(): string {
  // In dev: src/agents/tools/instagram-tool.ts → ../../../scripts/instagram/
  // In dist: dist/agents/tools/ → same depth from repo root
  const candidates = [
    path.resolve(__dirname, "../../../scripts/instagram/instagram_core.py"),
    path.resolve(__dirname, "../../../../scripts/instagram/instagram_core.py"),
    "/home/follox/clawdbot/scripts/instagram/instagram_core.py",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  // Final fallback — will produce a clear Python "file not found" error
  return candidates[0];
}

const SCRIPT_PATH = resolveScriptPath();
const PYTHON_BIN = process.env.INSTAGRAM_PYTHON_BIN ?? "python3";
const DEFAULT_TIMEOUT_MS = 45_000;

// ─── Schema ───────────────────────────────────────────────────────────────────

const INSTAGRAM_ACTIONS = ["profile", "post", "feed", "search", "hashtag", "download"] as const;

type InstagramAction = (typeof INSTAGRAM_ACTIONS)[number];

const InstagramSchema = Type.Object({
  action: Type.Union(
    INSTAGRAM_ACTIONS.map((a) => Type.Literal(a)),
    {
      description: [
        "Instagram action to perform:",
        "  • profile  — public profile info + recent posts (requires: username)",
        "  • post     — single post details: caption, likes, comments (requires: url)",
        "  • feed     — last N posts from a user (requires: username; optional: limit)",
        "  • search   — search accounts and hashtags (requires: query)",
        "  • hashtag  — top posts + volume for a hashtag (requires: tag)",
        "  • download — download image/video from post (requires: url, output)",
      ].join("\n"),
    },
  ),
  username: Type.Optional(
    Type.String({
      description: "Instagram username (without @). Used by: profile, feed.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description: "Full Instagram post/reel URL. Used by: post, download.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Search query string. Used by: search.",
    }),
  ),
  tag: Type.Optional(
    Type.String({
      description: "Hashtag name (with or without #). Used by: hashtag.",
    }),
  ),
  output: Type.Optional(
    Type.String({
      description: "Output file path for download action (e.g. /tmp/post.jpg).",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max posts to return for feed action. Default: 10, max: 50.",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

// ─── Python runner ────────────────────────────────────────────────────────────

interface PythonRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function runPython(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(PYTHON_BIN, [SCRIPT_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.on("error", () => finish(-1));
    child.on("exit", (code) => finish(code ?? -1));
  });
}

// ─── Action validators ────────────────────────────────────────────────────────

function validateParams(action: InstagramAction, params: Record<string, unknown>): string | null {
  if (action === "profile" || action === "feed") {
    if (!readStringParam(params, "username")) {
      return `action "${action}" requires a username`;
    }
  }
  if (action === "post") {
    if (!readStringParam(params, "url")) {
      return `action "post" requires a url`;
    }
  }
  if (action === "search") {
    if (!readStringParam(params, "query")) {
      return `action "search" requires a query`;
    }
  }
  if (action === "hashtag") {
    if (!readStringParam(params, "tag")) {
      return `action "hashtag" requires a tag`;
    }
  }
  if (action === "download") {
    if (!readStringParam(params, "url")) {
      return `action "download" requires a url`;
    }
    if (!readStringParam(params, "output")) {
      return `action "download" requires an output path`;
    }
  }
  return null;
}

function buildPythonArgs(action: InstagramAction, params: Record<string, unknown>): string[] {
  const args: string[] = ["--action", action];

  const username = readStringParam(params, "username");
  if (username) {
    args.push("--username", username);
  }

  const url = readStringParam(params, "url");
  if (url) {
    args.push("--url", url);
  }

  const query = readStringParam(params, "query");
  if (query) {
    args.push("--query", query);
  }

  const tag = readStringParam(params, "tag");
  if (tag) {
    args.push("--tag", tag);
  }

  const output = readStringParam(params, "output");
  if (output) {
    args.push("--output", output);
  }

  const limit = readNumberParam(params, "limit", { integer: true });
  if (limit !== null) {
    args.push("--limit", String(limit));
  }

  return args;
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createInstagramTool(): AnyAgentTool {
  return {
    label: "Instagram",
    name: "instagram",
    description: [
      "Scrape public Instagram data without authentication.",
      "Supports: profile info, post details, user feeds, hashtag exploration,",
      "account/hashtag search, and media downloads.",
      "Uses Playwright stealth browser to bypass bot detection.",
      "Note: Private accounts require cookie authentication (set INSTAGRAM_COOKIES_PATH).",
    ].join(" "),
    parameters: InstagramSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Resolve and validate action
      const rawAction = readStringParam(params, "action", { required: true });
      const action = rawAction as InstagramAction;
      if (!INSTAGRAM_ACTIONS.includes(action)) {
        return jsonResult({
          error: "invalid_action",
          message: `Unknown action "${action}". Valid actions: ${INSTAGRAM_ACTIONS.join(", ")}`,
        });
      }

      // Validate required params
      const validationError = validateParams(action, params);
      if (validationError) {
        return jsonResult({ error: "missing_param", message: validationError });
      }

      const pythonArgs = buildPythonArgs(action, params);
      const start = Date.now();

      const result = await runPython(pythonArgs);
      const tookMs = Date.now() - start;

      if (result.timedOut) {
        return jsonResult({
          ok: false,
          error: "timeout",
          message: `Instagram ${action} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
          tookMs,
        });
      }

      // Parse JSON output
      const rawOutput = result.stdout.trim();
      if (!rawOutput) {
        return jsonResult({
          ok: false,
          error: "no_output",
          message: "Python script produced no output",
          stderr: result.stderr.slice(-2000),
          exitCode: result.exitCode,
          tookMs,
        });
      }

      let parsed: unknown;
      try {
        // Find first complete JSON object in output (ignore any debug prints before it)
        const jsonStart = rawOutput.indexOf("{");
        const jsonStr = jsonStart >= 0 ? rawOutput.slice(jsonStart) : rawOutput;
        parsed = JSON.parse(jsonStr);
      } catch {
        return jsonResult({
          ok: false,
          error: "invalid_json",
          message: "Python script returned non-JSON output",
          raw: rawOutput.slice(0, 500),
          stderr: result.stderr.slice(-1000),
          tookMs,
        });
      }

      // Add timing metadata
      const payload =
        typeof parsed === "object" && parsed !== null
          ? { ...(parsed as Record<string, unknown>), _tookMs: tookMs }
          : parsed;

      return jsonResult(payload);
    },
  };
}
