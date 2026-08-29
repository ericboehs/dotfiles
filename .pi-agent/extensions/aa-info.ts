/**
 * Artificial Analysis model briefing, printed into the chat on every model
 * switch.
 *
 * When a session starts on a model, or you switch via /model or Ctrl+P, this
 * renders one dim status line through ctx.ui.notify("info") — the same channel
 * pi's own "switched to model" hint uses — so it appears in the session window
 * and simply scrolls away as the conversation grows. It is never attached to
 * the editor, the footer, or the LLM context.
 *
 *   Claude Opus 5 — int 62.5 · cod 77 · 53t/s · $10/1M · $1.80/task (AA)
 *
 * The two prices answer different questions: $/1M is the sticker rate, while
 * $/task is what one Intelligence Index task actually cost AA to run, which
 * folds in how many tokens the model burns thinking. Int/cod/t/s/$1M all use
 * AA's row for pi's current thinking level (or bare/max when it lacks one). A
 * trailing @med marks a task cost measured at a different effort.
 *
 * Because pi's status line is overwritten in place rather than appended, this
 * briefing takes the place of "Switched to X" instead of adding a line — the
 * model name is in both, and the footer shows the thinking level. See brief()
 * for the ordering that guarantees which of the two survives.
 *
 * Two free endpoints, both fetched once a week and cached together on disk per
 * agent directory (1k req/day, so the weekly pair is nothing):
 *
 *  - /api/v2/data/llms/models covers every model (624) and supplies the
 *    quality indices, output speed and the per-million rate. Its row is
 *    selected to match pi's current thinking level (then AA's bare/max row);
 *  - /api/v2/language/models/free covers 200 and supplies $/task — the cost of
 *    one Intelligence Index task, which is the closest thing AA publishes to
 *    "what will this model cost me to do a piece of work".
 *
 * Latency is deliberately absent. AA's own site and API disagree about it by
 * more than 2x for the same model and variant (Opus 5 max: 33.5s from the API,
 * 71.6s on the model page, while their speed figures differ by 5%), so the
 * seconds were noise dressed up as data. Everything shown here is the API's
 * 1k-prompt, single-query snapshot — the free tier ignores prompt_length.
 *
 * The fetch is fire-and-forget: handlers never await it, so neither startup nor
 * the model switch block on the network, and a failure is silent (the next
 * switch retries). A model the API does not know — local oMLX weights — shows
 * nothing.
 *
 * The key resolves from $ARTIFICIAL_ANALYSIS_API_KEY, then `fnox get` (macOS
 * Keychain), the same chain web-providers/config.ts uses. It is held only in
 * memory and never logged or persisted. Data by artificialanalysis.ai — the
 * trailing (AA) is the attribution their free API terms ask for.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENDPOINT = "https://artificialanalysis.ai/api/v2/data/llms/models";
/** Sparser (200 models, arbitrary effort variants) but carries cost per task. */
const COST_ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free";
const KEY_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** The subset of the free-tier LLM response this extension renders. */
interface AaModel {
  id?: string;
  name?: string;
  slug?: string;
  evaluations?: {
    artificial_analysis_intelligence_index?: number;
    artificial_analysis_coding_index?: number;
  };
  /** Blended 3:1 input/output rate, present for every model. */
  pricing?: { price_1m_blended_3_to_1?: number };
  median_output_tokens_per_second?: number;
}

interface AaCache {
  fetchedAt: number;
  data: AaModel[];
  /** AA slug → USD per Intelligence Index task. Absent marks a pre-cost cache. */
  costs?: Record<string, number>;
}

/** Minimal shape of the pi model objects carried by events and ctx. */
interface PiModel {
  id: string;
  provider?: string;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function cacheFile(): string {
  return join(agentDir(), "cache", "aa-models.json");
}

/** Lowercase alphanumerics only, so "Claude Opus 5" and "claude-opus-5" collide. */
function norm(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Every id this pi model might be listed under on AA. OpenRouter preset and
 * variant suffixes are stripped first (footer.ts's baseModelId), then both the
 * full id and its last path segment are tried — "moonshotai/Kimi-K3" is listed
 * as "Kimi K3", "accounts/fireworks/models/x" as "x".
 */
function candidateIds(modelId: string): string[] {
  const base = modelId
    .replace(/^hf:/i, "")
    .replace(/@preset\/[^:]*/i, "")
    .replace(/:[^/]+$/, "");
  const ids = [base, base.split("/").pop() ?? ""];
  return [...new Set(ids.map(norm).filter(Boolean))];
}

function lookup(aa: AaCache, model: PiModel): AaModel | undefined {
  const wanted = candidateIds(model.id);
  return aa.data.find((entry) =>
    wanted.some((w) => [norm(entry.id), norm(entry.slug), norm(entry.name)].includes(w)),
  );
}

/**
 * AA puts effort in the slug, while pi keeps it separately as thinkingLevel.
 * Always take the row for that level when present; the bare slug is AA's max
 * row and is the intentional fallback. Some models have no effort ladder at
 * all (GLM-5.3-Flash), for which the initially matched entry remains right.
 */
function forThinkingLevel(
  aa: AaCache,
  entry: AaModel,
  thinking: string | undefined,
): AaModel {
  if (!entry.slug || !thinking) return entry;
  const base = baseSlug(entry.slug);
  const family = aa.data.filter((candidate) => candidate.slug && baseSlug(candidate.slug) === base);
  const laddered = family.some((candidate) => candidate.slug !== base);
  if (!laddered) return entry;
  return family.find((candidate) => candidate.slug === `${base}-${thinking}`) ??
    family.find((candidate) => candidate.slug === base) ??
    entry;
}

/** One decimal, trailing zeros dropped: 62.9 → "62.9", 78 → "78". */
function fmt(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return String(parseFloat(value.toFixed(1)));
}

/** Whole once past 10, where the decimal is noise: 1.18 → "1.2", 93.87 → "94". */
function coarse(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 10 ? String(Math.round(value)) : fmt(value);
}

/**
 * Drop AA's trailing variant qualifiers — "(max)", "(high)", "(Adaptive
 * Reasoning, Max Effort)". They restate the thinking level the footer already
 * shows, and they read badly next to the trailing (AA). Repeated groups go
 * too; a name that is nothing but a qualifier is kept as-is.
 */
function cleanName(name: string): string {
  return name.replace(/(?:\s*\([^()]*\))+\s*$/, "").trim() || name.trim();
}

/**
 * AA's effort ladder, which is exactly pi's thinking levels. A cost slug is
 * either "<base>-<level>" or the bare base, which is their max-effort row.
 */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Same short names the footer's thinking chip uses, so the two agree. */
const EFFORT_NAMES: Record<string, string> = {
  minimal: "min",
  low: "lo",
  medium: "med",
  high: "hi",
  xhigh: "xhi",
  max: "max",
};

/** Strip a trailing effort suffix: "claude-opus-5-xhigh" → "claude-opus-5". */
function baseSlug(slug: string): string {
  const cut = slug.lastIndexOf("-");
  const suffix = cut === -1 ? "" : slug.slice(cut + 1);
  return EFFORTS.includes(suffix as (typeof EFFORTS)[number]) ? slug.slice(0, cut) : slug;
}

interface TaskCost {
  usd: number;
  /** The effort AA measured, or undefined when the model has no effort ladder. */
  effort?: string;
}

/**
 * USD per Intelligence Index task, for the effort being run when AA has it.
 *
 * The cost endpoint carries an arbitrary one or two efforts per model, so an
 * exact slug hit is not automatically the right one — the bare slug is their
 * max row, which is the wrong number for an xhigh session. Pick the closest
 * rung on the ladder and report which, since cost swings ~4x across it
 * (Opus 5: $1.80/task at xhigh, $0.43 at low). Models AA lists without any
 * effort variants have nothing to disclose, so they report no effort at all.
 */
function costPerTask(
  aa: AaCache,
  entry: AaModel,
  thinking: string | undefined,
): TaskCost | undefined {
  const costs = aa.costs;
  if (!costs || !entry.slug) return undefined;
  const base = baseSlug(entry.slug);
  const laddered = aa.data.some((m) => m.slug && m.slug !== base && baseSlug(m.slug) === base);
  const rung = (slug: string): string | undefined =>
    slug === base ? "max" : slug.startsWith(`${base}-`) ? slug.slice(base.length + 1) : undefined;

  const options: TaskCost[] = [];
  for (const [slug, usd] of Object.entries(costs)) {
    const effort = rung(slug);
    if (effort !== undefined && EFFORTS.includes(effort as (typeof EFFORTS)[number])) {
      options.push({ usd, effort });
    }
  }
  if (options.length === 0) return undefined;
  const [first] = options;
  if (!first) return undefined;
  if (!laddered) return { usd: first.usd };

  const want = EFFORTS.indexOf((thinking ?? "max") as (typeof EFFORTS)[number]);
  const rank = (o: TaskCost) => EFFORTS.indexOf(o.effort as (typeof EFFORTS)[number]);
  const distance = (o: TaskCost) => (want === -1 ? 0 : Math.abs(rank(o) - want));
  // Nearest rung; ties go to the harder-thinking one, the likelier read.
  const best = options.reduce((a, b) =>
    distance(b) < distance(a) || (distance(b) === distance(a) && rank(b) > rank(a)) ? b : a,
  );
  return best.effort === thinking ? { usd: best.usd } : best;
}

/** Cents matter at these sizes: $1.8012 → "$1.80", $0.0869 → "$0.09". */
function money(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `$${value.toFixed(value < 0.01 ? 3 : 2)}`;
}

/** Trailing zeros are noise on a headline rate: 10 → "$10", 0.237 → "$0.24". */
function rate(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `$${parseFloat(value.toFixed(value < 0.01 ? 3 : 2))}`;
}

function briefing(entry: AaModel, cost: TaskCost | undefined): string | undefined {
  const evals = entry.evaluations ?? {};
  const taskCost = money(cost?.usd);
  const parts = [
    typeof evals.artificial_analysis_intelligence_index === "number"
      ? `int ${fmt(evals.artificial_analysis_intelligence_index)}`
      : undefined,
    typeof evals.artificial_analysis_coding_index === "number"
      ? `cod ${fmt(evals.artificial_analysis_coding_index)}`
      : undefined,
    coarse(entry.median_output_tokens_per_second)
      ? `${coarse(entry.median_output_tokens_per_second)}t/s`
      : undefined,
    rate(entry.pricing?.price_1m_blended_3_to_1)
      ? `${rate(entry.pricing?.price_1m_blended_3_to_1)}/1M`
      : undefined,
    taskCost
      ? `${taskCost}/task${cost?.effort ? `@${EFFORT_NAMES[cost.effort] ?? cost.effort}` : ""}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  const name = cleanName(entry.name ?? entry.slug ?? entry.id ?? "");
  return `${name} — ${parts.join(" · ")} (AA)`;
}

let resolvedKey: string | undefined;
let keyResolved = false;

/** Env first, then fnox (Keychain). Silent: no key just means no briefings. */
async function apiKey(): Promise<string | undefined> {
  if (keyResolved) return resolvedKey;
  keyResolved = true;
  resolvedKey = process.env[KEY_ENV]?.trim() || (await fnoxGet(KEY_ENV));
  return resolvedKey;
}

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

async function readCache(): Promise<AaCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(), "utf8")) as AaCache;
    // A cache written before $/task existed is treated as a miss, so the costs
    // arrive on the next switch instead of a week later.
    if (typeof raw?.fetchedAt === "number" && Array.isArray(raw?.data) && raw?.costs) return raw;
  } catch {
    /* absent or corrupt cache is just a miss */
  }
  return undefined;
}

async function writeCache(aa: AaCache): Promise<void> {
  try {
    const file = cacheFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(aa));
    await rename(tmp, file);
  } catch {
    /* a failed cache write costs a refetch next week, nothing more */
  }
}

async function getJson(url: string, key: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`AA ${response.status}`);
  return response.json();
}

function rowsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? data : [];
}

/**
 * Cost per Intelligence Index task, keyed by slug. Best-effort: this endpoint
 * failing must not cost the briefing its quality numbers, so it resolves to an
 * empty map rather than rejecting.
 */
async function fetchCosts(key: string): Promise<Record<string, number>> {
  const costs: Record<string, number> = {};
  try {
    for (const row of rowsOf(await getJson(COST_ENDPOINT, key))) {
      const { slug, artificial_analysis_intelligence_index_cost: index } = row as {
        slug?: string;
        artificial_analysis_intelligence_index_cost?: { cost_per_task?: { total_cost?: number } };
      };
      const cost = index?.cost_per_task?.total_cost;
      if (typeof slug === "string" && typeof cost === "number") costs[slug] = cost;
    }
  } catch {
    /* no costs this week; the briefing simply drops its $/task segment */
  }
  return costs;
}

/** Two requests cover every model; concurrent callers share the in-flight pair. */
async function fetchAll(): Promise<AaCache | undefined> {
  const key = await apiKey();
  if (!key) return undefined;
  const [payload, costs] = await Promise.all([getJson(ENDPOINT, key), fetchCosts(key)]);
  const data = rowsOf(payload) as AaModel[];
  if (data.length === 0) return undefined;
  const aa: AaCache = { fetchedAt: Date.now(), data, costs };
  await writeCache(aa);
  return aa;
}

let inflightFetch: Promise<AaCache | undefined> | undefined;

async function loadData(): Promise<AaCache | undefined> {
  const cached = await readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  if (!inflightFetch) {
    inflightFetch = fetchAll().finally(() => {
      inflightFetch = undefined;
    });
  }
  return inflightFetch;
}

export default function (pi: ExtensionAPI): void {
  /**
   * Brief `model`, unless the user has already moved on.
   *
   * Both bits of ordering here exist because pi's showStatus() overwrites the
   * previous status line in place instead of appending, and pi prints its own
   * "Switched to X" the moment the model_select handlers resolve
   * (_emitModelSelect is the last await in cycleModel):
   *
   *  - the macrotask delay keeps the switch message from painting over the
   *    briefing — whoever paints last wins, so the briefing goes last;
   *  - the ctx.model check keeps a model merely cycled past from painting over
   *    the one actually landed on, whatever order their lookups finish in.
   *
   * There is deliberately no once-per-model memo. Cycling with Ctrl+P fires an
   * event for every model passed through, so a one-shot briefing got spent —
   * and instantly painted over — on models never landed on, which is what made
   * GLM-5.3-Flash look like it had no data. Re-briefing costs a cached lookup.
   */
  const brief = async (ctx: ExtensionContext, model: PiModel | undefined): Promise<void> => {
    if (!model?.id || !ctx.hasUI) return;
    const aa = await loadData();
    const matched = aa ? lookup(aa, model) : undefined;
    const entry = aa && matched ? forThinkingLevel(aa, matched, ctx.thinkingLevel) : undefined;
    const line =
      aa && entry ? briefing(entry, costPerTask(aa, entry, ctx.thinkingLevel)) : undefined;
    if (!line) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Cycling with Ctrl+P fires an event per model passed through; only the
    // model actually landed on gets to speak, whatever order the loads finish.
    if (ctx.model?.id !== model.id || ctx.model?.provider !== model.provider) return;
    ctx.ui.notify(line, "info");
  };

  // Fire-and-forget on purpose: pi awaits event handlers, and a cold fetch must
  // never delay the model switch or session start it decorates.
  const queue = (ctx: ExtensionContext, model: PiModel | undefined): void => {
    void brief(ctx, model).catch(() => {
      /* silent: a failed fetch just means no briefing, and the next switch retries */
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    queue(ctx, ctx.model ?? undefined);
  });

  pi.on("model_select", async (event, ctx) => {
    queue(ctx, event.model);
  });
}
