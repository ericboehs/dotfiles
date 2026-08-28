/**
 * config.ts — persisted configuration shared by web_search and web_fetch.
 *
 * Lives at <agent-dir>/web.json (0600). Missing file, missing keys, and
 * unknown names all degrade to defaults rather than erroring: a bad edit
 * must never take web access down mid-session.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SEARCH_BACKENDS = ["brave", "tavily", "exa", "firecrawl", "codex"] as const;
export const FETCH_TIERS = ["plain", "curl", "chrome", "safari", "firecrawl", "tinyfish"] as const;

export type SearchBackend = (typeof SEARCH_BACKENDS)[number];
export type FetchTierName = (typeof FETCH_TIERS)[number];
export type Format = "native" | "serp" | "answer";
export type Excerpts = "auto" | "short" | "long";

export const FORMATS: Format[] = ["native", "serp", "answer"];
export const EXCERPT_MODES: Excerpts[] = ["auto", "short", "long"];

export interface WebConfig {
  search: { order: SearchBackend[]; off: SearchBackend[] };
  fetch: { order: FetchTierName[]; off: FetchTierName[] };
  format: Format;
  excerpts: Excerpts;
  /** backend/tier name -> epoch ms before which it must not be tried again. */
  skipUntil: Record<string, number>;
}

/**
 * Default chains.
 *
 * Search is ordered best-extract-first rather than cheapest-first. Failover
 * only fires on exhaustion, so the head of the chain serves nearly every
 * query, and these monthly quotas do not roll over — unspent Tavily credits
 * are simply lost, so there is nothing to save them for.
 *
 * Measured on a three-query bake-off: Brave answers in ~0.5s but returns
 * teaser snippets, which cost a follow-up web_fetch and, worse, once produced
 * a truncated line quoting a *different model's* price inside a pricing query.
 * Fuller extracts are both faster end-to-end and less likely to be misread, so
 * Brave now sits third as the high-volume overflow (2000/mo, the largest pool
 * and the least useful per call).
 *
 * Firecrawl is deliberately behind Brave: search costs it 2 credits per call
 * out of the same 1000-credit pool that funds the fetch ladder's last tier,
 * where it is the only thing that can rescue a page nothing else can read.
 * A credit is worth more there than as a fourth opinion on a SERP.
 *
 * The fetch ladder runs local-first, then TinyFish, then Firecrawl, then
 * Safari. TinyFish renders in a real Chromium and costs nothing at any wallet
 * balance, so it takes the first rescue attempt and leaves Firecrawl's credits
 * for the pages it cannot read. Safari is last despite being free: it drives
 * the real GUI app, so it is the one tier a user can *see* running, and that
 * makes it a last resort rather than a mid-ladder default.
 */
export const DEFAULT_CONFIG: WebConfig = {
  search: { order: ["tavily", "exa", "brave", "firecrawl", "codex"], off: [] },
  fetch: { order: ["plain", "curl", "chrome", "tinyfish", "firecrawl", "safari"], off: [] },
  format: "native",
  excerpts: "auto",
  skipUntil: {},
};

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function configPath(): string {
  return join(agentDir(), "web.json");
}

function uniqueNames<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim().toLowerCase() as T;
    if (allowed.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function coerce(raw: unknown): WebConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const skipUntil: Record<string, number> = {};
  const now = Date.now();
  for (const [k, v] of Object.entries(obj.skipUntil ?? {})) {
    // Expired entries are dropped on read, so a stale file self-heals.
    if (typeof v === "number" && Number.isFinite(v) && v > now) skipUntil[k] = v;
  }
  return {
    search: {
      order: uniqueNames(obj.search?.order, SEARCH_BACKENDS) ?? [...DEFAULT_CONFIG.search.order],
      off: uniqueNames(obj.search?.off, SEARCH_BACKENDS) ?? [],
    },
    fetch: {
      order: uniqueNames(obj.fetch?.order, FETCH_TIERS) ?? [...DEFAULT_CONFIG.fetch.order],
      off: uniqueNames(obj.fetch?.off, FETCH_TIERS) ?? [],
    },
    format: FORMATS.includes(obj.format) ? obj.format : DEFAULT_CONFIG.format,
    excerpts: EXCERPT_MODES.includes(obj.excerpts) ? obj.excerpts : DEFAULT_CONFIG.excerpts,
    skipUntil,
  };
}

let cached: WebConfig | undefined;

export async function loadConfig(): Promise<WebConfig> {
  if (cached) return cached;
  try {
    cached = coerce(JSON.parse(await readFile(configPath(), "utf8")));
  } catch {
    cached = coerce({});
  }
  return cached;
}

export async function saveConfig(next: WebConfig): Promise<void> {
  cached = next;
  const path = configPath();
  const tmp = `${path}.tmp`;
  await mkdir(agentDir(), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

export async function mutateConfig(fn: (cfg: WebConfig) => void): Promise<WebConfig> {
  const cfg = structuredClone(await loadConfig());
  fn(cfg);
  await saveConfig(cfg);
  return cfg;
}

/** Names in configured order, minus disabled ones and minus anything still cooling off. */
export function activeChain<T extends string>(order: T[], off: T[], skipUntil: Record<string, number>): T[] {
  const now = Date.now();
  return order.filter((name) => !off.includes(name) && !((skipUntil[name] ?? 0) > now));
}

export async function markSkip(name: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  await mutateConfig((cfg) => {
    // Never shorten an existing cool-off: two failures in one turn would
    // otherwise reset the longer quota window to the shorter transient one.
    if (!((cfg.skipUntil[name] ?? 0) > until)) cfg.skipUntil[name] = until;
  });
}

export async function clearSkips(): Promise<void> {
  await mutateConfig((cfg) => {
    cfg.skipUntil = {};
  });
}

/* ------------------------------------------------------------------- keys */

/**
 * Env var per backend, in preference order. Brave takes two: the "Data for AI"
 * plan is a different subscription with its own key and its own 2000/month,
 * and it is the only one whose plan includes `extra_snippets` — the difference
 * between a teaser and a real extract. Prefer it, fall back to the plain key.
 *
 * TinyFish also takes two: their own docs use TINYFISH_API_KEY, but the key is
 * stored here under TINY_FISH_API_KEY. Accept both so a fresh machine that
 * followed the vendor docs still resolves.
 */
export const KEY_ENV: Record<string, string[]> = {
  brave: ["BRAVE_AI_API_KEY", "BRAVE_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  exa: ["EXA_API_KEY"],
  firecrawl: ["FIRECRAWL_API_KEY"],
  tinyfish: ["TINY_FISH_API_KEY", "TINYFISH_API_KEY"],
};

const keyCache = new Map<string, ResolvedKey | undefined>();

function fnoxGet(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const p = spawn("fnox", ["get", name], { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.on("data", (d) => (out += d));
      p.on("error", () => resolve(undefined));
      p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Resolve a provider key from the environment, then fnox (Keychain). Values are
 * cached for the process and never logged, persisted, or shown by /web.
 */
/**
 * Which credential a backend resolved to, so callers can adapt to the plan.
 * `env` is the variable name only — the value never leaves this module except
 * as `key`, and is never logged or persisted.
 */
export interface ResolvedKey {
  key: string;
  env: string;
}

export async function resolveKeyInfo(backend: string): Promise<ResolvedKey | undefined> {
  const names = KEY_ENV[backend];
  if (!names?.length) return undefined;
  if (keyCache.has(backend)) return keyCache.get(backend);

  let found: ResolvedKey | undefined;
  for (const env of names) {
    const value = process.env[env]?.trim() || (await fnoxGet(env));
    if (value) {
      found = { key: value, env };
      break;
    }
  }
  keyCache.set(backend, found);
  return found;
}

export async function resolveKey(backend: string): Promise<string | undefined> {
  return (await resolveKeyInfo(backend))?.key;
}

export function forgetKeys(): void {
  keyCache.clear();
}
