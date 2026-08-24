import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Auto-register every model currently loaded in the local oMLX server so it
// shows up in pi's /model picker. Re-runs on startup and on /reload.
//
// oMLX is an OpenAI-compatible server; GET /v1/models is the source of truth for
// what's loaded. We enrich each entry with real metadata read from the model's
// on-disk config.json (context length, vision support, architecture), falling
// back to the API-reported values when a config file isn't available.
const OMLX_BASE_URL = process.env.OMLX_BASE_URL ?? "http://localhost:8000/v1";
// oMLX default --model-dir is ~/.omlx/models; override with OMLX_MODEL_DIR.
const OMLX_MODEL_DIR =
  process.env.OMLX_MODEL_DIR ?? join(homedir(), ".omlx", "models");
const MAX_OUTPUT_TOKENS = 32768;

interface OmlxApiModel {
  id: string;
  object?: string;
  owned_by?: string;
  max_model_len?: number | null;
}

interface ModelMeta {
  contextWindow?: number;
  vision: boolean;
  reasoning: boolean;
}

// Reasoning heuristic across families (used when config metadata is missing).
function isReasoningName(id: string): boolean {
  return /qwen3|a3b|thinking|reason|deepseek-r|glm-.*-air|-r1/i.test(id);
}

function metaFromConfig(config: Record<string, unknown>): ModelMeta {
  const text = (config.text_config ?? config) as Record<string, unknown>;
  const ctxRaw =
    (text.max_position_embeddings as number | undefined) ??
    (config.max_position_embeddings as number | undefined);
  const contextWindow =
    typeof ctxRaw === "number" && ctxRaw > 0 ? ctxRaw : undefined;

  const languageOnly = config.language_model_only === true;
  const vision =
    !languageOnly &&
    ("vision_config" in config || "vision_config" in text);

  const modelType = String(config.model_type ?? "").toLowerCase();
  const arch = String(
    (config.architectures as string[] | undefined)?.[0] ?? "",
  ).toLowerCase();
  const reasoning = /qwen3|qwen3_5|moe|reason|thinking|deepseek-?r|glm/.test(
    `${modelType} ${arch}`,
  );

  return { contextWindow, vision, reasoning };
}

// Recursively scan the model dir and map basename (== API model id) -> metadata.
async function loadConfigMetadata(): Promise<Map<string, ModelMeta>> {
  const map = new Map<string, ModelMeta>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasConfig = entries.some(
      (e) => e.isFile() && e.name === "config.json",
    );
    if (hasConfig) {
      const basename = dir.split("/").pop() ?? dir;
      try {
        const raw = await readFile(join(dir, "config.json"), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!map.has(basename)) map.set(basename, metaFromConfig(parsed));
      } catch {
        // ignore unreadable/unparseable config
      }
      return; // a model dir won't contain nested model dirs
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await walk(join(dir, e.name), depth + 1);
      }
    }
  }

  await walk(OMLX_MODEL_DIR, 0);
  return map;
}

export default async function (pi: ExtensionAPI) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  let apiModels: OmlxApiModel[] = [];
  try {
    const res = await fetch(`${OMLX_BASE_URL}/models`, {
      signal: controller.signal,
    });
    if (res.ok) {
      const payload = (await res.json()) as { data?: OmlxApiModel[] };
      apiModels = payload.data ?? [];
    }
  } catch {
    // oMLX not running / unreachable — register nothing, don't block startup.
  } finally {
    clearTimeout(timeout);
  }

  // Only chat-capable models (ones that report a context length). This drops
  // utility models like "MarkItDown" that expose max_model_len: null.
  const chatModels = apiModels.filter(
    (m) => typeof m.max_model_len === "number" && m.max_model_len > 0,
  );
  if (chatModels.length === 0) return;

  const configMeta = await loadConfigMetadata();

  pi.registerProvider("omlx", {
    name: "oMLX (local)",
    baseUrl: OMLX_BASE_URL,
    apiKey: "omlx", // dummy: local server ignores it, pi just needs auth present
    api: "openai-completions",
    models: chatModels.map((m) => {
      const meta = configMeta.get(m.id);
      // Prefer the server's served context length; fall back to config.
      const served = m.max_model_len as number;
      const contextWindow = meta?.contextWindow
        ? Math.min(served, meta.contextWindow)
        : served;
      const reasoning = meta?.reasoning ?? isReasoningName(m.id);
      const input: ("text" | "image")[] = meta?.vision
        ? ["text", "image"]
        : ["text"];
      return {
        id: m.id,
        name: m.id,
        reasoning,
        input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(contextWindow, MAX_OUTPUT_TOKENS),
        // Qwen3.5-family thinking control on oMLX:
        //  - chat_template_kwargs.enable_thinking is the master on/off switch.
        //    When true, reasoning is emitted in the reasoning_content channel;
        //    when false, output is clean. Omitting it leaks reasoning into the
        //    main content, so we always send an explicit boolean (omitWhenOff:
        //    false). This maps pi's thinking on/off to enable_thinking.
        //  - reasoning_effort adds granularity (server accepts low/medium/high).
        ...(reasoning
          ? {
              compat: {
                supportsReasoningEffort: true,
                thinkingFormat: "chat-template" as const,
                chatTemplateKwargs: {
                  enable_thinking: {
                    $var: "thinking.enabled" as const,
                    omitWhenOff: false,
                  },
                },
              },
            }
          : {}),
      };
    }),
  });
}
