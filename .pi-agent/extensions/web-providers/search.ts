/**
 * search.ts — the web_search provider chain.
 *
 * One tool, many backends, operator-owned order. The model never picks a
 * vendor. Failover happens on quota / auth / 5xx / timeout only — never on
 * "no results", because an unlucky query must not burn the next subscription.
 */
import {
  activeChain,
  loadConfig,
  markSkip,
  resolveKeyInfo,
  type Excerpts,
  type Format,
  type ResolvedKey,
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
  /** Monthly requests still allowed. Brave is the only backend that reports this. */
  remaining?: number;
  /** The monthly allowance `remaining` counts down from, when it is reported. */
  limit?: number;
}

export interface SearchOptions {
  recency?: string;
  linksOnly?: boolean;
  maxResults?: number;
  /** Per-call override of the configured excerpt length. */
  excerpts?: Excerpts;
  /**
   * Ask for the deep tier first. The model sets this and nothing more — it
   * never names a vendor, exactly as it never picks `recency` for the chain.
   */
  hard?: boolean;
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
/** Per-minute buckets: long enough for the window to roll, no longer. */
const PACE_COOLOFF_MS = 60_000;
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
/**
 * A 429 that only means "slow down". Perplexity says so in the body: its
 * `request_rate_limit_exceeded` is a requests-per-minute bucket, and the
 * account still has credit. Reading it as a spent allowance benched the deep
 * tier for a day over two `hard` calls sent at once.
 *
 * Keyed on Perplexity's exact error type, not on the words "rate limit":
 * Brave's monthly-quota 429 says RATE_LIMITED and "Request rate limit
 * exceeded" too, and that one really is spent until the month rolls over.
 */
function isPaceLimit(status: number, body: string): boolean {
  return status === 429 && /\brequest_rate_limit_exceeded\b/.test(body);
}

export function cooloffForStatus(status: number, body = ""): number {
  const authShaped =
    /SUBSCRIPTION_TOKEN_INVALID|"component"\s*:\s*"authentication"|invalid api key|unauthorized/i.test(body);
  if (status === 401 || status === 403 || (status === 422 && authShaped)) return QUOTA_COOLOFF_MS;
  if (isPaceLimit(status, body)) return PACE_COOLOFF_MS;
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
  // "quota exhausted" on a per-minute bucket sends whoever reads the log to
  // check a billing page that is fine.
  if (isPaceLimit(status, body)) return new BackendError(`rate limited (${status}) ${detail}`, cooloff);
  return new BackendError(`quota exhausted (${status}) ${detail}`, cooloff);
}

/**
 * Brave's `X-RateLimit-Remaining` and `X-RateLimit-Limit` are both
 * `per-second, monthly` ("0, 1930" and "1, 2000"); this reads the monthly half
 * of either. Monthly 0 is a real value (spent), so distinguish it from a
 * missing or unparseable header.
 */
export function parseBraveMonthly(header: string | null): number | undefined {
  const parts = (header ?? "").split(",").map((s) => Number(s.trim()));
  const monthly = parts[1];
  return parts.length > 1 && Number.isFinite(monthly) ? monthly : undefined;
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
  cred: ResolvedKey,
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
  // Always ask. The "Data for AI" plan returns extra_snippets whether or not
  // the parameter is set, and the search-only plan omits them even when it is,
  // so the parameter is really just future-proofing. What matters is whether
  // we *render* them, decided below.
  params.set("extra_snippets", "true");

  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
  const headers = { "X-Subscription-Token": cred.key, Accept: "application/json" };

  let res = await fetch(url, { headers, signal: timeout(signal) });
  if (res.status === 429) {
    // "0, 1985" -> per-second spent, monthly fine.
    const monthlyLeft = parseBraveMonthly(res.headers.get("x-ratelimit-remaining"));
    if (monthlyLeft === undefined || monthlyLeft > 0) {
      await new Promise((r) => setTimeout(r, 1100));
      res = await fetch(url, { headers, signal: timeout(signal) });
    }
  }
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  const hits: SearchHit[] = [];
  // extra_snippets roughly triples the response (206 -> ~1450 chars per
  // result) and measured no better on a six-query ground-truth set: much of
  // the addition is boilerplate. On the query that demoted Brave it surfaced
  // the correct price that truncation had cut off *and* a competing model's
  // price that truncation had been hiding -- more complete and more
  // contaminated at once. That is a fair trade only when depth was asked for,
  // so it rides on `long` rather than the default.
  const useExtra = excerpts === "long";
  for (const r of data?.web?.results ?? []) {
    const extra = useExtra && Array.isArray(r.extra_snippets) ? r.extra_snippets.map(clean).join(" … ") : "";
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
  return {
    hits,
    searchedAs,
    remaining: parseBraveMonthly(res.headers.get("x-ratelimit-remaining")),
    limit: parseBraveMonthly(res.headers.get("x-ratelimit-limit")),
  };
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

/**
 * The Agent API's answer text. `output_text` is an SDK convenience property, so
 * a raw fetch walks `output[]` itself; prefer the convenience field when it is
 * there, fall back to the documented REST shape.
 */
function agentText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return cleanProse(data.output_text);
  if (!Array.isArray(data?.output)) return "";
  const parts: string[] = [];
  for (const item of data.output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (typeof c?.text === "string") parts.push(c.text);
  }
  return cleanProse(parts.join("\n"));
}

/**
 * `clean()` is for one-line excerpts and folds every whitespace run into a
 * space — newlines included. The Agent API answers in Markdown, and a table
 * folded onto one line stops being a table. Keep the line structure; only
 * tidy runs of spaces and runs of blank lines.
 */
function cleanProse(text: string): string {
  return text
    .replace(/<\/?strong>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sonar's top-level `citations` is gone; sources ride on a typed output item. */
function agentSources(output: any): string[] {
  if (!Array.isArray(output)) return [];
  const urls: string[] = [];
  for (const item of output) {
    if (item?.type !== "search_results" || !Array.isArray(item.results)) continue;
    for (const r of item.results) if (typeof r?.url === "string") urls.push(r.url);
  }
  return urls;
}

/**
 * Perplexity Agent API — the deep tier.
 *
 * Sonar's chat-completions endpoint was retired on 2026-09-27 and now answers
 * 403 with a migration notice. This is the Agent API: `POST /v1/responses`
 * (the documented alias of `/v1/agent`), `preset` where Sonar had `model`, and
 * `input` where it had `messages`.
 *
 * `fast` is the documented successor to `sonar` and enables web search on its
 * own, so the plain request carries no tools block. Only a recency filter adds
 * one — the filter keys kept their names, they just moved under the tool.
 *
 * Returns `hits: []` with the synthesis in `answer`, the shape codex already
 * uses, so `render()` hands back the prose under `native` instead of collapsing
 * it into a one-item link list. Under `links_only` the caller asked for links,
 * so the citations become the hits and the essay is dropped by the renderer.
 */
async function perplexitySearch(
  query: string,
  opts: SearchOptions,
  key: string,
  signal?: AbortSignal,
): Promise<BackendResult> {
  const body: Record<string, unknown> = { preset: "fast", input: query };
  const days = recencyDays(opts.recency);
  if (days) {
    body.tools = [
      {
        type: "web_search",
        filters: {
          search_recency_filter: days <= 1 ? "day" : days <= 7 ? "week" : days <= 31 ? "month" : "year",
        },
      },
    ];
  }

  const res = await fetch("https://api.perplexity.ai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(signal),
  });
  if (!res.ok) throw httpError(res.status, await res.text());

  const data = (await res.json()) as any;
  const answer = agentText(data);
  const sources = agentSources(data?.output);
  // Nothing usable at all is a failure, not an empty answer: the caller asked
  // for the deep tier specifically. Cool-off 0 — pass to the next backend for
  // this call, but do not bench a paid key over one thin response.
  if (!answer && !sources.length) throw new BackendError("no answer and no search results", 0);
  if (opts.linksOnly) {
    return { hits: sources.map((url) => ({ title: url, url })), answer, sources };
  }
  return { hits: [], answer: answer || undefined, sources };
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
  cred: ResolvedKey | undefined,
  codex: CodexRunner,
  signal?: AbortSignal,
): Promise<BackendResult> {
  switch (backend) {
    case "brave":
      return braveSearch(query, opts, cfg.excerpts, cred!, signal);
    case "tavily":
      return tavilySearch(query, opts, cfg.format, cred!.key, signal);
    case "exa":
      return exaSearch(query, opts, cfg.excerpts, cfg.format, cred!.key, signal);
    case "firecrawl":
      return firecrawlSearch(query, opts, cred!.key, signal);
    case "codex": {
      const { answer, sources } = await codex(
        query,
        { recency: opts.recency, linksOnly: opts.linksOnly === true, wantAnswer: cfg.format !== "serp" },
        signal,
      );
      return { hits: [], answer, sources };
    }
    case "perplexity":
      return perplexitySearch(query, opts, cred!.key, signal);
  }
}

/**
 * The deep tier. Kept out of `search.order` on purpose, and not for its list
 * price — ~$0.004 undercuts Exa's $0.007. It is the only backend here with no
 * free monthly allowance, so in the fallback slot it would bill for searches
 * that exa and brave cover for nothing. A backend that can be fallen into is
 * one that gets spent on queries that did not need it.
 */
const DEEP_BACKEND = "perplexity" as const;

/** The deep tier, but only if the operator left it on and it is not cooling. */
function deepTier(cfg: WebConfig): SearchBackend | undefined {
  if (cfg.search.off.includes(DEEP_BACKEND)) return undefined;
  if ((cfg.skipUntil[DEEP_BACKEND] ?? 0) > Date.now()) return undefined;
  return DEEP_BACKEND;
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
  // `hard` promotes the deep tier to the head. It does not touch failover:
  // if Perplexity is spent or benched, the chain below runs exactly as it
  // always has, so the escalation can never become an exit from the chain.
  const deep = opts.hard ? deepTier(cfg) : undefined;
  const ordered = deep ? [deep, ...chain.filter((b) => b !== deep)] : chain;
  const tried: string[] = [];
  const linksOnly = opts.linksOnly === true;

  if (!ordered.length) {
    throw new Error(
      "web_search: every backend is disabled or cooling off. Run /web to see the chain, /web reset to clear skips.",
    );
  }

  for (const backend of ordered) {
    let cred: ResolvedKey | undefined;
    if (backend !== "codex") {
      cred = await resolveKeyInfo(backend);
      if (!cred) {
        tried.push(`${backend}: no API key`);
        continue;
      }
    }

    deps.onAttempt?.(`${backend}: ${query}`);
    try {
      const result = await callBackend(backend, query, opts, cfg, cred, deps.codex, signal);
      // The footer names who answered, the way web_fetch names its tier. Shape
      // differs by backend (ranked excerpts vs. written prose) and so does how
      // far to trust it, which the model cannot otherwise tell from the text.
      // It reports; it does not invite a choice — there is no parameter that
      // could act on it. Brave also adds its quota, the only backend that
      // reports one on success; Tavily/Exa/Firecrawl only say when it's gone.
      const left = result.remaining === undefined ? "" : ` · ${quotaLeft(result.remaining, result.limit)} this month`;
      const text = `${render(result, cfg.format, cfg.excerpts, linksOnly)}\n\n---\n[via ${backend}${left}]`;
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
/**
 * What one call costs, and what each month covers before anything bills — for
 * the /web test table. The free allowance is the half that decides behaviour:
 * tavily, exa and brave together cover ~4,400 searches a month at no charge,
 * so the price that matters for a fallback is "free until spent", not list.
 *
 * Checked 2026-10-07, against live headers where the vendor sends them:
 * - brave: `x-ratelimit-limit: 1, 2000` on a 31-day window. A legacy free
 *   plan — Brave now offers new accounts $5/mo of credit (~1,000 at $5/1k)
 *   instead, so a re-created key would land on the smaller allowance.
 * - exa: `costDollars` was 0.007 for 5 results with highlights, all of it
 *   search; highlights are not billed as contents. $10/mo free ≈ 1,400.
 * - tavily: 1,000 credits/mo free, 1 per basic search (docs; no header).
 * - perplexity: no complimentary API credits on any plan (help center), so
 *   every call bills from the first one.
 */
export const COST_PER_CALL: Record<SearchBackend, string> = {
  brave: "1 req · 2,000 free/mo",
  tavily: "1 credit · 1,000 free/mo",
  exa: "~$0.007 · $10 free/mo",
  firecrawl: "2 credits",
  codex: "subscription tokens",
  // `fast` on gpt-5.6-luna, at the preset's median 1000 in / 500 out tokens,
  // plus one web_search invocation. Checked against Perplexity's published
  // rates; the Agent API replaced the old per-request Sonar fee this sat on.
  perplexity: "~$0.004 · no free tier",
};

/** "1,930 of 2,000 left", or "1,930 left" when the allowance was not reported. */
export function quotaLeft(remaining: number, limit?: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return limit === undefined ? `${n(remaining)} left` : `${n(remaining)} of ${n(limit)} left`;
}

/**
 * The /web test cost cell. Each label is `<per call> · <free allowance>`; when
 * the probe came back with a live count, that replaces the allowance half, so
 * Brave reads "1 req · 1,930 of 2,000 left" rather than the plan's ceiling. A
 * failed probe has no headers to read and keeps the static label.
 */
export function costLabel(r: Pick<ProbeResult, "backend" | "remaining" | "limit">): string {
  const label = COST_PER_CALL[r.backend];
  if (r.remaining === undefined) return label;
  return `${label.split(" · ")[0]} · ${quotaLeft(r.remaining, r.limit)}`;
}

/**
 * Artificial Analysis Search Index, for the `/web test` table — only the
 * providers that publish a row. It is a dash for everything else, and it is
 * worth understanding why rather than reading it as a ranking of this chain:
 * the index scores a whole agent turn with an answer model attached, so it is
 * not comparable to the per-call latency and character counts beside it.
 * Only perplexity has a row here; Octen (77) is the alternative `hard` was
 * weighed against but is not a backend in this chain.
 *
 * The 80 is also a different product from the one below: it was measured on
 * "Perplexity Search (medium)", while this calls the Agent API `fast` preset.
 * Snapshot: 2026-10, and the board moves.
 */
export const SEARCH_INDEX: Partial<Record<SearchBackend, string>> = {
  perplexity: "80",
};

export interface ProbeResult {
  backend: SearchBackend;
  state: "ready" | "off" | "cooling" | "no key";
  ok: boolean;
  ms: number;
  chars: number;
  hits: number;
  detail?: string;
  /** Live monthly quota, for backends that report it (Brave). */
  remaining?: number;
  limit?: number;
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
      : (cfg.skipUntil[backend] ?? 0) > now
        ? "cooling"
        : "ready";

    let cred: ResolvedKey | undefined;
    if (backend !== "codex") {
      cred = await resolveKeyInfo(backend);
      if (!cred) {
        out.push({ backend, state: "no key", ok: false, ms: 0, chars: 0, hits: 0 });
        continue;
      }
    }

    deps.onAttempt?.(backend);
    const t0 = Date.now();
    try {
      const result = await callBackend(backend, query, {}, cfg, cred, deps.codex, signal);
      const text = render(result, cfg.format, cfg.excerpts, false);
      out.push({
        backend,
        state,
        ok: true,
        ms: Date.now() - t0,
        chars: text.length,
        hits: result.hits.length || (result.answer ? 1 : 0),
        remaining: result.remaining,
        limit: result.limit,
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
