/**
 * search.ts — the web_search provider chain.
 *
 * One tool, many backends, operator-owned order. The model never picks a
 * vendor. Failover happens on quota / auth / 5xx / timeout only — never on
 * "no results", because an unlucky query must not burn the next subscription.
 */
import {
  activeChain,
  currentConfig,
  loadConfig,
  markSkip,
  resolveKey,
  type Excerpts,
  type Format,
  type SearchBackend,
  type WebConfig,
} from "./config.ts";

export interface SearchHit {
  title: string;
  url: string;
  excerpt?: string;
  age?: string;
}

export interface BackendResult {
  hits: SearchHit[];
  /** Prose written by the provider (Codex, Tavily include_answer, ...). */
  answer?: string;
  sources?: string[];
  /**
   * The terms the backend actually searched, when it silently rewrote the
   * ones it was given. Only set when it differs — an echo of the query as
   * sent would be noise the caller already knows.
   */
  searchedAs?: string;
}

export interface SearchOptions {
  recency?: string;
  linksOnly?: boolean;
  maxResults?: number;
  /** Per-call override of the configured excerpt length. */
  excerpts?: Excerpts;
}

export type CodexRunner = (
  query: string,
  opts: { recency?: string; linksOnly?: boolean; wantAnswer: boolean },
  signal?: AbortSignal,
) => Promise<{ answer: string; sources: string[] }>;

/**
 * A backend declined. `cooloffMs > 0` persists a skip so the next call starts
 * further down the chain; 0 means "not this request" (e.g. format unsupported)
 * and leaves the backend in rotation.
 */
class BackendError extends Error {
  // Written as a plain field rather than a constructor parameter property:
  // strip-only TypeScript loaders (node --experimental-strip-types) reject
  // parameter properties, and this module has to load under both jiti and node.
  readonly cooloffMs: number;

  constructor(message: string, cooloffMs: number) {
    super(message);
    this.cooloffMs = cooloffMs;
  }
}

const QUOTA_COOLOFF_MS = 24 * 60 * 60 * 1000; // monthly allowances: re-probe daily
const TRANSIENT_COOLOFF_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

const EXCERPT_CHARS: Record<Excerpts, number> = { short: 200, auto: 1200, long: 2500 };

function timeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([t, signal]) : t;
}

function clean(text: string | undefined): string {
  return (text ?? "").replace(/<\/?strong>/g, "").replace(/\s+/g, " ").trim();
}

function recencyDays(recency?: string): number | undefined {
  switch (recency?.toLowerCase()) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 31;
    case "year":
      return 365;
    default:
      return undefined;
  }
}

/**
 * How long a given HTTP status should bench a backend. Shared by the search
 * chain and the fetch ladder so both agree on what "spent" means — Firecrawl
 * bills one pool for both, so a 402 seen while fetching is the same news as a
 * 402 seen while searching.
 *
 * Brave is the awkward one: it answers 422 both for a revoked subscription
 * token and for a malformed query, so the body has to break the tie. Guessing
 * "auth" would silently bench a working backend for a day; guessing "bug"
 * would re-hit a dead key on every search forever.
 */
export function cooloffForStatus(status: number, body = ""): number {
  const authShaped =
    /SUBSCRIPTION_TOKEN_INVALID|"component"\s*:\s*"authentication"|invalid api key|unauthorized/i.test(body);
  if (status === 401 || status === 403 || (status === 422 && authShaped)) return QUOTA_COOLOFF_MS;
  if (status === 402 || status === 429 || status === 432) return QUOTA_COOLOFF_MS;
  if (status >= 500) return TRANSIENT_COOLOFF_MS;
  // Other 4xx: almost certainly our request shape. Do not cool off — surfacing
  // it on every call is how the bug gets noticed and fixed.
  return 0;
}

/** Classify an HTTP failure. The chain adds the backend name, so messages here stay unprefixed. */
function httpError(status: number, body: string): BackendError {
  const detail = body.slice(0, 200).replace(/\s+/g, " ").trim();
  const cooloff = cooloffForStatus(status, body);
  if (cooloff === 0) return new BackendError(`HTTP ${status} ${detail}`, 0);
  if (status >= 500) return new BackendError(`upstream ${status} ${detail}`, cooloff);
  if (status === 401 || status === 403 || status === 422) {
    return new BackendError(`auth rejected (${status}) ${detail}`, cooloff);
  }
  return new BackendError(`quota exhausted (${status}) ${detail}`, cooloff);
}

/* ----------------------------------------------------------------- brave */

/**
 * Brave allows one request per second on top of the monthly allowance. That
 * 429 is a pace limit, not exhaustion: sleeping past it keeps the cheapest
 * backend in play instead of dumping the session onto a paid one.
 */
async function braveSearch(
  query: string,
  opts: SearchOptions,
  excerpts: Excerpts,
  key: string,
  signal?: AbortSignal,
): Promise<BackendResult> {
  const params = new URLSearchParams({
    q: query,
    count: String(opts.maxResults ?? 5),
    country: "us",
    search_lang: "en",
  });
  const days = recencyDays(opts.recency);
  if (days) params.set("freshness", days <= 1 ? "pd" : days <= 7 ? "pw" : days <= 31 ? "pm" : "py");
  // Plan-gated: silently absent on the Search tier, harmless to ask for.
  if (excerpts === "long") params.set("extra_snippets", "true");

  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
  const headers = { "X-Subscription-Token": key, Accept: "application/json" };

  let res = await fetch(url, { headers, signal: timeout(signal) });
  if (res.status === 429) {
    // "x-ratelimit-remaining: 0, 1985" -> per-second spent, monthly fine.
    const remaining = (res.headers.get("x-ratelimit-remaining") ?? "").split(",").map((s) => Number(s.trim()));
    const monthlyLeft = remaining.length > 1 ? remaining[1] : undefined;
    if (monthlyLeft === undefined || monthlyLeft > 0) {
      await new Promise((r) => setTimeout(r, 1100));
      res = await fetch(url, { headers, signal: timeout(signal) });
    }
  }
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  const hits: SearchHit[] = [];
  for (const r of data?.web?.results ?? []) {
    const extra = Array.isArray(r.extra_snippets) ? r.extra_snippets.map(clean).join(" … ") : "";
    const body = clean(r.description);
    hits.push({
      title: clean(r.title),
      url: r.url,
      excerpt: extra ? `${body} … ${extra}` : body,
      age: r.age || r.page_age || undefined,
    });
  }
  // Brave silently spellchecks and rewrites, and only reports `altered` when
  // it did. Compared case-insensitively because it also lowercases the echo,
  // which is not a change worth announcing.
  const altered = typeof data?.query?.altered === "string" ? data.query.altered.trim() : "";
  const searchedAs = altered && altered.toLowerCase() !== query.trim().toLowerCase() ? altered : undefined;
  return { hits, searchedAs };
}

/* ---------------------------------------------------------------- tavily */

async function tavilySearch(
  query: string,
  opts: SearchOptions,
  format: Format,
  key: string,
  signal?: AbortSignal,
): Promise<BackendResult> {
  const body: Record<string, unknown> = {
    query,
    search_depth: "basic",
    max_results: opts.maxResults ?? 5,
    include_answer: format === "answer",
  };
  const days = recencyDays(opts.recency);
  if (days) body.time_range = days <= 1 ? "day" : days <= 7 ? "week" : days <= 31 ? "month" : "year";

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(signal),
  });
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  const hits: SearchHit[] = (data?.results ?? []).map((r: any) => ({
    title: clean(r.title),
    url: r.url,
    // Tavily's default `content` is already an extract, not a teaser.
    excerpt: (r.content ?? "").trim(),
    age: r.published_date || undefined,
  }));
  const answer = typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : undefined;
  return { hits, answer };
}

/* ------------------------------------------------------------------- exa */

/**
 * Exa's /answer endpoint: a synthesized answer with citations, at $5/1k
 * against /search's $7/1k. Cheaper *and* smaller — measured 336–626 chars
 * versus 10–17KB of raw results — and unlike a nested search agent it returns
 * in 1.2–1.5s, occasionally faster than the plain search it replaces.
 *
 * The `subject` field is the point of the schema, not the tidy shape. Asked
 * about GLM-5.3 *Flash*, this endpoint answered about GLM-5.3 and buried the
 * swap in fluent prose. Making it name what it answered about turns a silent
 * misattribution into one the reader can see. It is reported, never judged
 * here: "GLM-5.3" is a substring of the query that asked for "GLM-5.3 Flash",
 * so any automatic check would wave it through.
 */
const ANSWER_SCHEMA = {
  type: "object",
  required: ["answer", "subject"],
  properties: {
    answer: { type: "string", description: "The answer in prose, with inline [n] citation markers." },
    subject: {
      type: "string",
      description:
        "The exact entity, product, or version the answer describes, copied verbatim from the source. Do not normalise it toward the question.",
    },
  },
} as const;

async function exaAnswer(query: string, key: string, signal?: AbortSignal): Promise<BackendResult> {
  const res = await fetch("https://api.exa.ai/answer", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, text: false, outputSchema: ANSWER_SCHEMA }),
    signal: timeout(signal),
  });
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  const raw = data?.answer;
  // Tolerate a plain string: outputSchema is a request, not a guarantee.
  const answer = String((typeof raw === "object" && raw ? raw.answer : raw) ?? "").trim();
  if (!answer) throw new BackendError("answer endpoint returned nothing", 0);
  const subject = typeof raw === "object" && raw ? String(raw.subject ?? "").trim() : "";
  const sources = (data?.citations ?? []).map((c: any) => c?.url).filter(Boolean);
  return {
    hits: [],
    answer: subject ? `${answer}\n\n(Exa answered about: ${subject})` : answer,
    sources,
  };
}

async function exaSearch(
  query: string,
  opts: SearchOptions,
  excerpts: Excerpts,
  format: Format,
  key: string,
  signal?: AbortSignal,
): Promise<BackendResult> {
  if (format === "answer") {
    // /answer takes no date filter. Silently dropping a recency request would
    // answer a different question than the one asked, so decline and let a
    // backend that can honour it take the call.
    if (opts.recency) throw new BackendError("answer endpoint cannot filter by recency", 0);
    return exaAnswer(query, key, signal);
  }

  const body: Record<string, unknown> = {
    query,
    numResults: opts.maxResults ?? 5,
    // Highlights are extractive and bundled with Search: the cheap way to get
    // real page text without paying for Contents or an LLM summary.
    contents: { highlights: { numSentences: excerpts === "short" ? 2 : excerpts === "long" ? 8 : 4 } },
  };
  const days = recencyDays(opts.recency);
  if (days) body.startPublishedDate = new Date(Date.now() - days * 86_400_000).toISOString();

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(signal),
  });
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  const hits: SearchHit[] = (data?.results ?? []).map((r: any) => ({
    title: clean(r.title),
    url: r.url,
    excerpt: Array.isArray(r.highlights) ? r.highlights.join(" … ").trim() : clean(r.text),
    age: r.publishedDate || undefined,
  }));
  return { hits };
}

/* ------------------------------------------------------------- firecrawl */

/**
 * Search only — deliberately no scrapeOptions. Scraping is what the web_fetch
 * ladder does, and asking for it here would spend a credit per result.
 */
async function firecrawlSearch(
  query: string,
  opts: SearchOptions,
  key: string,
  signal?: AbortSignal,
): Promise<BackendResult> {
  const body: Record<string, unknown> = {
    query,
    limit: opts.maxResults ?? 5,
    sources: ["web"],
  };
  const days = recencyDays(opts.recency);
  if (days) body.tbs = days <= 1 ? "qdr:d" : days <= 7 ? "qdr:w" : days <= 31 ? "qdr:m" : "qdr:y";

  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(signal),
  });
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  if (data?.success === false) {
    throw new BackendError(String(data?.error ?? "request failed").slice(0, 200), TRANSIENT_COOLOFF_MS);
  }
  const raw = Array.isArray(data?.data) ? data.data : (data?.data?.web ?? []);
  const hits: SearchHit[] = raw.map((r: any) => ({
    title: clean(r.title),
    url: r.url,
    excerpt: clean(r.description ?? r.markdown),
  }));
  return { hits };
}

/* --------------------------------------------------------------- render */

function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : `${t.slice(0, limit).trimEnd()}…`;
}

function renderHits(hits: SearchHit[], limit: number, linksOnly: boolean): string {
  if (linksOnly) return hits.map((h) => `- [${h.title || h.url}](${h.url})`).join("\n");
  return hits
    .map((h) => {
      const age = h.age ? `  (${h.age})` : "";
      const excerpt = h.excerpt ? `\n  ${truncate(h.excerpt, limit)}` : "";
      return `- ${h.title || h.url}${age}\n  ${h.url}${excerpt}`;
    })
    .join("\n");
}

function renderAnswer(answer: string, sources: string[] = []): string {
  const cited = sources.filter((u) => !answer.includes(u)).slice(0, 10);
  return cited.length ? `${answer}\n\nSources:\n${cited.map((u) => `- ${u}`).join("\n")}` : answer;
}

function render(result: BackendResult, format: Format, excerpts: Excerpts, linksOnly: boolean): string {
  const limit = EXCERPT_CHARS[linksOnly ? "short" : format === "serp" ? "short" : excerpts];
  // Leads rather than trails: "these results answer a different question than
  // the one you asked" is worth knowing before reading them, not after.
  const prefix = result.searchedAs ? `(searched as: ${result.searchedAs})\n\n` : "";
  if (format === "answer") {
    if (!result.answer) throw new BackendError("format=answer unsupported by this backend", 0);
    return prefix + renderAnswer(result.answer, result.sources ?? result.hits.map((h) => h.url));
  }
  if (format === "serp") {
    if (!result.hits.length && result.answer) {
      // A prose backend in SERP mode: hand back the citations, drop the essay.
      const urls = result.sources ?? [];
      return urls.length ? prefix + urls.map((u) => `- ${u}`).join("\n") : "No results.";
    }
    return result.hits.length ? prefix + renderHits(result.hits, limit, linksOnly) : "No results.";
  }
  // native
  if (result.answer && !result.hits.length) return prefix + renderAnswer(result.answer, result.sources);
  return result.hits.length ? prefix + renderHits(result.hits, limit, linksOnly) : "No results.";
}

/* ---------------------------------------------------------------- chain */

/**
 * Dispatch one backend. Shared by the chain and by /web test so a probe
 * exercises exactly the code path a real search would take — a diagnostic that
 * tests something adjacent to the real thing is worse than no diagnostic.
 */
async function callBackend(
  backend: SearchBackend,
  query: string,
  opts: SearchOptions,
  cfg: WebConfig,
  key: string | undefined,
  codex: CodexRunner,
  signal?: AbortSignal,
): Promise<BackendResult> {
  switch (backend) {
    case "brave":
      return braveSearch(query, opts, cfg.excerpts, key!, signal);
    case "tavily":
      return tavilySearch(query, opts, cfg.format, key!, signal);
    case "exa":
      return exaSearch(query, opts, cfg.excerpts, cfg.format, key!, signal);
    case "firecrawl":
      return firecrawlSearch(query, opts, key!, signal);
    case "codex": {
      const { answer, sources } = await codex(
        query,
        { recency: opts.recency, linksOnly: opts.linksOnly === true, wantAnswer: cfg.format !== "serp" },
        signal,
      );
      return { hits: [], answer, sources };
    }
  }
}

export interface ChainOutcome {
  text: string;
  backend: SearchBackend;
  tried: string[];
  /** The excerpt length actually used, after any per-call override. */
  excerpts: Excerpts;
  /** Set only when the backend rewrote the query it was given. */
  searchedAs?: string;
}

export async function runSearchChain(
  query: string,
  opts: SearchOptions,
  deps: { codex: CodexRunner; onAttempt?: (msg: string) => void },
  signal?: AbortSignal,
): Promise<ChainOutcome> {
  const stored = await loadConfig();
  // A per-call override changes excerpt length only. Backend order stays
  // operator-owned: the model may say how much text it wants, never from whom.
  const cfg: WebConfig = opts.excerpts ? { ...stored, excerpts: opts.excerpts } : stored;
  const chain = activeChain(cfg.search.order, cfg.search.off, cfg.skipUntil);
  const tried: string[] = [];
  const linksOnly = opts.linksOnly === true;

  if (!chain.length) {
    throw new Error(
      "web_search: every backend is disabled or cooling off. Run /web to see the chain, /web reset to clear skips.",
    );
  }

  for (const backend of chain) {
    let key: string | undefined;
    if (backend !== "codex") {
      key = await resolveKey(backend);
      if (!key) {
        tried.push(`${backend}: no API key`);
        continue;
      }
    }

    deps.onAttempt?.(`${backend}: ${query}`);
    try {
      const result = await callBackend(backend, query, opts, cfg, key, deps.codex, signal);
      const text = render(result, cfg.format, cfg.excerpts, linksOnly);
      return { text, backend, tried, excerpts: cfg.excerpts, searchedAs: result.searchedAs };
    } catch (e) {
      const err = e as Error;
      if (signal?.aborted) throw err; // user cancelled: stop the whole chain
      const cooloff = e instanceof BackendError ? e.cooloffMs : TRANSIENT_COOLOFF_MS;
      if (cooloff > 0) await markSkip(backend, cooloff);
      tried.push(`${backend}: ${err.message}`);
    }
  }

  throw new Error(`web_search: no backend answered.\n  - ${tried.join("\n  - ")}`);
}

/**
 * What one call to each backend costs, for the /web test table. Static rather
 * than measured: only Tavily reports usage, and a diagnostic should not need
 * four different billing endpoints to tell you what it just spent.
 */
export const COST_PER_CALL: Record<SearchBackend, string> = {
  brave: "1 req of 2000/mo",
  tavily: "1 credit",
  exa: "1 search (~$0.007)",
  firecrawl: "2 credits",
  codex: "subscription tokens",
};

export interface ProbeResult {
  backend: SearchBackend;
  state: "ready" | "off" | "cooling" | "no key";
  ok: boolean;
  ms: number;
  chars: number;
  hits: number;
  detail?: string;
}

/**
 * Probe every backend once, in chain order, and report. Deliberately does NOT
 * write cool-offs: you run a diagnostic to learn the state of the world, not
 * to change it. It also probes backends that are off or cooling, since "has it
 * recovered yet?" is the main reason to ask.
 */
export async function probeBackends(
  query: string,
  backends: SearchBackend[],
  deps: { codex: CodexRunner; onAttempt?: (msg: string) => void },
  signal?: AbortSignal,
): Promise<ProbeResult[]> {
  const cfg = await loadConfig();
  const now = Date.now();
  const out: ProbeResult[] = [];

  for (const backend of backends) {
    const state: ProbeResult["state"] = cfg.search.off.includes(backend)
      ? "off"
      : cfg.skipUntil[backend] > now
        ? "cooling"
        : "ready";

    let key: string | undefined;
    if (backend !== "codex") {
      key = await resolveKey(backend);
      if (!key) {
        out.push({ backend, state: "no key", ok: false, ms: 0, chars: 0, hits: 0 });
        continue;
      }
    }

    deps.onAttempt?.(backend);
    const t0 = Date.now();
    try {
      const result = await callBackend(backend, query, {}, cfg, key, deps.codex, signal);
      const text = render(result, cfg.format, cfg.excerpts, false);
      out.push({
        backend,
        state,
        ok: true,
        ms: Date.now() - t0,
        chars: text.length,
        hits: result.hits.length || (result.answer ? 1 : 0),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      out.push({
        backend,
        state,
        ok: false,
        ms: Date.now() - t0,
        chars: 0,
        hits: 0,
        detail: (e as Error).message.slice(0, 160),
      });
    }
    // Brave allows one request per second; a probe that trips its own rate
    // limit would report a failure it caused itself.
    await new Promise((r) => setTimeout(r, 1100));
  }
  return out;
}

/** Footer chip text, e.g. "search:brave long". */
export function chipFor(backend: SearchBackend, excerpts?: Excerpts): string {
  const cfg = currentConfig();
  const used = excerpts ?? cfg.excerpts;
  const bits = [`search:${backend}`];
  if (cfg.format !== "native") bits.push(cfg.format);
  // Show the length actually used, so a per-call override is visible rather
  // than the chip quietly reporting the configured default instead.
  if (used !== "auto") bits.push(used);
  return bits.join(" ");
}
