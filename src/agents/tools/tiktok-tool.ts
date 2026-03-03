/**
 * tiktok-tool.ts — Outil natif OpenClaw pour TikTok
 *
 * Wraps les scripts Python CLI du MCP TikTok existant via child_process.
 * Réutilise tout le code Playwright + cookies TikSimPro sans duplication.
 *
 * Scripts: ~/clawd/skills/tiktok/scripts/
 * MCP source: ~/clawd/mcp-servers/tiktok-mcp/
 *
 * Actions:
 *   search    — rechercher des vidéos par mot-clé
 *   profile   — profil utilisateur + vidéos récentes
 *   video     — infos détaillées d'une vidéo
 *   hashtag   — stats et vidéos d'un hashtag
 *   download  — télécharger une vidéo (sans watermark)
 *   trending  — vidéos For You Page / sons trending
 */

import { exec as nodeExec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";

const execAsync = promisify(nodeExec);

// ─── Config ──────────────────────────────────────────────────────────────────

/** Racine des scripts Python TikTok (skill natif) */
const SCRIPTS_DIR =
  process.env.TIKTOK_SCRIPTS_DIR ?? path.join(os.homedir(), "clawd", "skills", "tiktok", "scripts");

/** Python interpreter à utiliser */
const PYTHON_BIN = process.env.TIKTOK_PYTHON_BIN ?? "python3";

/** Timeout en ms pour chaque appel (les appels Playwright sont lents) */
const EXEC_TIMEOUT_MS = parseInt(process.env.TIKTOK_EXEC_TIMEOUT_MS ?? "120000", 10);

// ─── Schema TypeBox ───────────────────────────────────────────────────────────

const TikTokToolSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("search"),
      Type.Literal("profile"),
      Type.Literal("video"),
      Type.Literal("hashtag"),
      Type.Literal("download"),
      Type.Literal("trending"),
    ],
    {
      description:
        "Action TikTok: search (recherche vidéos), profile (profil user), video (infos vidéo), hashtag (stats tag), download (télécharger), trending (For You / sons trending).",
    },
  ),
  query: Type.Optional(
    Type.String({ description: "Terme de recherche (requis pour action=search)." }),
  ),
  username: Type.Optional(
    Type.String({
      description: "Pseudo TikTok, avec ou sans @ (requis pour action=profile).",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description: "URL ou ID de la vidéo TikTok (requis pour action=video et action=download).",
    }),
  ),
  tag: Type.Optional(
    Type.String({
      description: "Hashtag à explorer, avec ou sans # (requis pour action=hashtag).",
    }),
  ),
  output_path: Type.Optional(
    Type.String({
      description:
        "Chemin de sortie pour le téléchargement (action=download). Auto-généré si absent.",
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description:
        "Nombre de résultats à retourner (défaut: 10 pour search/profile/hashtag, 20 pour trending).",
      minimum: 1,
      maximum: 50,
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("feed"), Type.Literal("sounds")], {
      description:
        "Mode pour action=trending : 'feed' (vidéos FYP) ou 'sounds' (sons trending). Défaut: feed.",
    }),
  ),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Exécute un script Python TikTok et retourne les données JSON parsées.
 * Les scripts sortent du JSON pur sur stdout ; les logs vont sur stderr.
 */
async function runTikTokScript(
  scriptName: string,
  args: string[],
  env?: Record<string, string>,
): Promise<unknown> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);

  // Sanitize args: éviter l'injection shell avec des quotes
  const safeArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `${PYTHON_BIN} ${scriptPath} ${safeArgs}`;

  let stdout: string;
  let stderr: string;

  try {
    ({ stdout, stderr } = await execAsync(cmd, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB max output
      env: { ...process.env, ...env },
    }));
  } catch (err: unknown) {
    // execAsync throws when exit code != 0 OR timeout
    const execErr = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };

    if (execErr.killed) {
      throw new Error(
        `TikTok script timeout après ${EXEC_TIMEOUT_MS / 1000}s — TikTok peut être lent ou bloquer les requêtes`,
        { cause: err },
      );
    }

    // Try parsing JSON from stdout anyway (scripts exit(1) avec JSON error)
    const rawOut = (execErr.stdout ?? "").trim();
    if (rawOut) {
      try {
        const parsed = JSON.parse(rawOut);
        return parsed;
      } catch {
        // Ignore parse error, fall through to generic error
      }
    }

    throw new Error(
      `TikTok script ${scriptName} échoué: ${execErr.message ?? "erreur inconnue"}` +
        (execErr.stderr ? `\nSTDERR: ${execErr.stderr.slice(0, 500)}` : ""),
      { cause: err },
    );
  }

  // Log stderr (logs Python) uniquement en mode verbose
  if (stderr && process.env.TIKTOK_VERBOSE === "true") {
    process.stderr.write(`[tiktok-tool] ${scriptName} stderr: ${stderr}\n`);
  }

  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`TikTok script ${scriptName} n'a produit aucun output`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`TikTok script ${scriptName} a sorti du JSON invalide: ${raw.slice(0, 200)}`);
  }
}

// ─── Action Handlers ──────────────────────────────────────────────────────────

async function handleSearch(params: Record<string, unknown>): Promise<unknown> {
  const query = readStringParam(params, "query", { required: true });
  const count = readNumberParam(params, "count", { integer: true }) ?? 10;
  return runTikTokScript("tiktok-search.py", [query, "--count", String(count)]);
}

async function handleProfile(params: Record<string, unknown>): Promise<unknown> {
  const username = readStringParam(params, "username", { required: true });
  const count = readNumberParam(params, "count", { integer: true }) ?? 10;
  return runTikTokScript("tiktok-profile.py", [username, "--count", String(count)]);
}

async function handleVideo(params: Record<string, unknown>): Promise<unknown> {
  const url = readStringParam(params, "url", { required: true });
  return runTikTokScript("tiktok-video.py", [url]);
}

async function handleHashtag(params: Record<string, unknown>): Promise<unknown> {
  const tag = readStringParam(params, "tag", { required: true });
  const count = readNumberParam(params, "count", { integer: true }) ?? 10;
  return runTikTokScript("tiktok-hashtag.py", [tag, "--count", String(count)]);
}

async function handleDownload(params: Record<string, unknown>): Promise<unknown> {
  const url = readStringParam(params, "url", { required: true });
  const outputPath = readStringParam(params, "output_path") ?? "";

  const args = [url];
  if (outputPath) {
    args.push(outputPath);
  }

  return runTikTokScript("tiktok-download.py", args);
}

async function handleTrending(params: Record<string, unknown>): Promise<unknown> {
  const count = readNumberParam(params, "count", { integer: true }) ?? 20;
  const mode = readStringParam(params, "mode") ?? "feed";

  if (mode !== "feed" && mode !== "sounds") {
    throw new ToolInputError("mode doit être 'feed' ou 'sounds'");
  }

  return runTikTokScript("tiktok-trending.py", ["--count", String(count), "--mode", mode]);
}

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createTikTokTool(): AnyAgentTool {
  return {
    label: "TikTok",
    name: "tiktok",
    description:
      "Automatisation TikTok via Playwright stealth + cookies (lecture + écriture). " +
      "Actions: search (recherche vidéos), profile (profil + vidéos user), video (infos détaillées), " +
      "hashtag (stats + vidéos), download (télécharger sans watermark), trending (For You Page / sons). " +
      "Nécessite les cookies TikSimPro (~30 jours de validité). Réponses en JSON.",
    parameters: TikTokToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      let result: unknown;

      switch (action) {
        case "search":
          result = await handleSearch(params);
          break;
        case "profile":
          result = await handleProfile(params);
          break;
        case "video":
          result = await handleVideo(params);
          break;
        case "hashtag":
          result = await handleHashtag(params);
          break;
        case "download":
          result = await handleDownload(params);
          break;
        case "trending":
          result = await handleTrending(params);
          break;
        default:
          return jsonResult({
            error: "action_invalide",
            message: `Action inconnue: '${action}'. Actions disponibles: search, profile, video, hashtag, download, trending.`,
          });
      }

      return jsonResult(result);
    },
  };
}
