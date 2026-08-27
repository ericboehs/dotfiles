import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";
import { resilientFetch } from "./web-fetch-resilient/fetch-core.ts";
import {
  activeChain,
  clearSkips,
  EXCERPT_MODES,
  FETCH_TIERS,
  FORMATS,
  KEY_ENV,
  loadConfig,
  markSkip,
  mutateConfig,
  resolveKey,
  SEARCH_BACKENDS,
  type Excerpts,
  type FetchTierName,
  type Format,
  type SearchBackend,
  type WebConfig,
} from "./web-providers/config.ts";
import { chipFor, cooloffForStatus, COST_PER_CALL, probeBackends, runSearchChain } from "./web-providers/search.ts";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
// Plain OpenAI API keys speak the same Responses API shape, just at the
// standard endpoint — the Codex one rejects them with a 401.
const OPENAI_URL = "https://api.openai.com/v1/responses";
const SEARCH_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 100_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/* ------------------------------------------------------------------ search */

interface Auth {
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  codex: boolean;
}

function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  } catch {
    return undefined;
  }
}

function accountId(token: string): string | undefined {
  const auth = decodeJwt(token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function resolveAuth(ctx: ExtensionContext): Promise<Auth | undefined> {
  let models: ReturnType<typeof ctx.modelRegistry.getAll>;
  try {
    models = ctx.modelRegistry.getAll();
  } catch {
    return undefined;
  }
  for (const provider of ["openai-codex", "openai"] as const) {
    const candidates = models
      .filter((m) => m.provider === provider && !/audio|realtime|image|tts|embed/.test(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    const model = candidates.find((m) => /mini|flash|sol/.test(m.id)) ?? candidates[0];
    if (!model) continue;
    try {
      const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (resolved.ok && resolved.apiKey) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(resolved.headers ?? {})) if (v !== null) headers[k] = v as string;
        return { apiKey: resolved.apiKey, model: model.id, headers, codex: provider === "openai-codex" };
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function collectOutput(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed.output) ? parsed.output : [];
    } catch {
      return [];
    }
  }
  const items: unknown[] = [];
  let final: unknown[] | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const ev = JSON.parse(data) as Record<string, any>;
      if (ev.type === "response.output_item.done" && ev.item) items.push(ev.item);
      if ((ev.type === "response.completed" || ev.type === "response.done") && Array.isArray(ev.response?.output)) {
        final = ev.response.output;
      }
    } catch {
      /* skip malformed frame */
    }
  }
  return final?.length ? final : items;
}

function extractAnswer(output: unknown[]): { answer: string; sources: string[] } {
  const parts: string[] = [];
  const sources = new Set<string>();
  for (const item of output as any[]) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part?.text === "string" && part.text.trim()) parts.push(part.text);
        for (const ann of part?.annotations ?? []) {
          if (typeof ann?.url === "string") sources.add(ann.url.replace(/[?&]utm_source=openai\b/, ""));
        }
      }
    }
    for (const src of item?.action?.sources ?? []) {
      if (typeof src?.url === "string") sources.add(src.url.replace(/[?&]utm_source=openai\b/, ""));
    }
  }
  return { answer: parts.join("\n").trim(), sources: [...sources] };
}

interface CodexOptions {
  recency?: string;
  linksOnly?: boolean;
}

/**
 * The Codex backend: one API call, and OpenAI's servers run the whole
 * search-read-write loop. Slow and quota-hungry compared with a SERP API,
 * which is why the chain puts it last — but it is the only backend that
 * answers rather than lists.
 */
async function codexSearch(
  query: string,
  opts: CodexOptions,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ answer: string; sources: string[] }> {
  const auth = await resolveAuth(ctx);
  if (!auth) throw new Error("No OpenAI/Codex credentials. Run /login and sign in with your Codex subscription.");

  const instructions = (
    opts.linksOnly
      ? [
          "Search the web and return ONLY a markdown list of the most relevant pages, most useful first,",
          "one per line as `- [title](url)`, at most 10.",
          "No summary, no commentary, no preamble, no trailing notes.",
        ]
      : [
          "Search the web and answer concisely, grounded only in what you find.",
          "Lead with the answer. Include inline markdown links to sources.",
        ]
  )
    .concat(opts.recency ? [`Prefer sources from the past ${opts.recency}.`] : [])
    .join(" ");

  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
  };
  if (auth.codex) {
    const id = accountId(auth.apiKey);
    if (id) headers["chatgpt-account-id"] = id;
    headers.originator = "pi";
  }

  const res = await fetch(auth.codex ? CODEX_URL : OPENAI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: auth.model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      store: false,
      stream: true,
      tool_choice: "required",
      parallel_tool_calls: true,
    }),
    signal: signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);

  const { answer, sources } = extractAnswer(collectOutput(await res.text()));
  if (!answer && sources.length === 0) throw new Error("Search returned nothing.");

  // links mode: the list is the payload, so never hand back sources that would
  // be rendered a second time underneath it.
  if (opts.linksOnly) {
    return { answer: answer || sources.slice(0, 10).map((u) => `- ${u}`).join("\n"), sources: [] };
  }
  return { answer, sources };
}

/* ----------------------------------------------------------------- youtube */

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

function isYouTube(url: URL): boolean {
  return YT_HOSTS.has(url.hostname.toLowerCase());
}

function stamp(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function cueSeconds(line: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->/.exec(line.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Auto-generated captions roll the previous line into the next cue, so emit each
// distinct line once and drop a [mm:ss] marker every minute for navigation.
function vttToText(vtt: string, markEvery = 60): string {
  const out: string[] = [];
  let last = "";
  let at = 0;
  let nextMark = 0;
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(WEBVTT|Kind:|Language:|NOTE\b|STYLE\b|REGION\b)/.test(line)) continue;
    const t = cueSeconds(line);
    if (t !== undefined) {
      at = t;
      continue;
    }
    if (line.includes("-->") || /^\d+$/.test(line)) continue;
    const text = line
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === last) continue;
    if (at >= nextMark) {
      out.push(`\n[${stamp(at)}]`);
      nextMark = Math.floor(at / markEvery) * markEvery + markEvery;
    }
    out.push(text);
    last = text;
  }
  return out.join(" ").replace(/ *\n */g, "\n").trim();
}

async function youtubeTranscript(url: string, signal?: AbortSignal): Promise<string> {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-yt-"));
  try {
    let meta = "";
    try {
      meta = await run(
        "yt-dlp",
        [
          "--skip-download", "--no-simulate", "--no-warnings",
          "--write-auto-subs", "--write-subs",
          "--sub-langs", "en-orig,en,en-US",
          "--sub-format", "vtt", "--convert-subs", "vtt",
          "--paths", dir, "-o", "%(id)s",
          "--print", "%(title)s\u0001%(channel)s\u0001%(duration_string)s\u0001%(webpage_url)s",
          url,
        ],
        "",
        signal,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(msg)) throw new Error("yt-dlp is not installed (brew install yt-dlp).");
      throw new Error(`yt-dlp failed: ${msg}`);
    }

    const files = readdirSync(dir).filter((f) => f.endsWith(".vtt"));
    // Manually authored `.en.vtt` beats the `.en-orig` ASR track when both exist:
    // same words, but punctuated and capitalized. Falls back to whatever is there.
    const pick =
      files.find((f) => /\.en\.vtt$/.test(f)) ?? files.find((f) => /\.en-US\.vtt$/.test(f)) ?? files[0];
    if (!pick) throw new Error("No English captions available for this video.");

    const [title, channel, duration, canonical] = meta.trim().split("\u0001");
    const head = [title, channel && `by ${channel}`, duration, canonical || url].filter(Boolean).join(" · ");
    return `${head}\n\n${vttToText(readFileSync(join(dir, pick), "utf-8"))}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------- fetch */

function run(cmd: string, args: string[], input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(0, 200) || `${cmd} exited ${code}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function truncate(body: string, maxChars: number, url: string): string {
  let text = body.trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} of ${text.length} chars — re-fetch with a larger max_chars for more]`;
  }
  return `# ${url}\n\n${text}`;
}

/* --------------------------------------------------------------- /web ui */

function chainLine(order: string[], off: string[], skipUntil: Record<string, number>): string {
  const now = Date.now();
  return order
    .map((name) => {
      if (off.includes(name)) return `${name} (off)`;
      if (skipUntil[name] > now) return `${name} (skipped)`;
      return name;
    })
    .join(" \u203a ");
}

function relative(ms: number): string {
  const mins = Math.max(1, Math.round((ms - Date.now()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

async function statusText(cfg: WebConfig): Promise<string> {
  const lines = [
    `search    ${chainLine(cfg.search.order, cfg.search.off, cfg.skipUntil)}`,
    `fetch     ${chainLine(cfg.fetch.order, cfg.fetch.off, cfg.skipUntil)}`,
    `format    ${cfg.format}    excerpts ${cfg.excerpts}`,
    "",
  ];
  const creds: string[] = [];
  for (const name of SEARCH_BACKENDS) {
    if (name === "codex") {
      creds.push("codex      subscription (via /login)");
      continue;
    }
    // Presence only. The value is never rendered, logged, or persisted.
    const has = (await resolveKey(name)) ? "\u2713" : "\u2717";
    const note = name === "firecrawl" ? "  (search + fetch share one credit pool)" : "";
    creds.push(`${name.padEnd(10)} ${has} ${KEY_ENV[name]}${note}`);
  }
  lines.push(...creds);

  const skipped = Object.entries(cfg.skipUntil).filter(([, until]) => until > Date.now());
  if (skipped.length) {
    lines.push("", ...skipped.map(([name, until]) => `skipped   ${name} for ${relative(until)}`));
  }
  return lines.join("\n");
}

const TEST_QUERY = "what is the capital of France";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function runTest(args: string[], ctx: ExtensionContext): Promise<string> {
  const includeCodex = args[0]?.toLowerCase() === "all";
  const query = (includeCodex ? args.slice(1) : args).join(" ").trim() || TEST_QUERY;
  const backends = SEARCH_BACKENDS.filter((b) => includeCodex || b !== "codex");

  const results = await probeBackends(query, [...backends], {
    codex: (q, opts, s) => codexSearch(q, { recency: opts.recency, linksOnly: opts.linksOnly }, ctx, s),
  });

  const lines = [
    `query: "${query}"`,
    "",
    `${pad("backend", 11)}${pad("state", 9)}${pad("result", 10)}${pad("ms", 7)}${pad("chars", 8)}cost`,
  ];
  for (const r of results) {
    const verdict = r.ok ? `${r.hits} hits` : "FAIL";
    const ms = r.ok ? String(r.ms) : r.ms ? String(r.ms) : "\u2013";
    lines.push(
      `${pad(r.backend, 11)}${pad(r.state, 9)}${pad(verdict, 10)}${pad(ms, 7)}${pad(r.ok ? String(r.chars) : "\u2013", 8)}${COST_PER_CALL[r.backend]}`,
    );
  }

  const failures = results.filter((r) => !r.ok && r.detail);
  if (failures.length) {
    lines.push("", ...failures.map((r) => `${r.backend}: ${r.detail}`));
  }
  // Only successes are counted as spend: auth and quota rejections are not
  // billed, and claiming otherwise would make the number untrustworthy.
  lines.push("", `${results.filter((r) => r.ok).length} successful call(s) billed. Cool-offs unchanged.`);
  if (!includeCodex) lines.push("codex not probed \u2014 use /web test all to include it.");
  return lines.join("\n");
}

const WEB_HELP = [
  "/web                                   show chains, keys, cool-offs",
  "/web search order tavily exa brave firecrawl codex",
  "/web fetch order plain curl chrome safari firecrawl",
  "/web search off|on <name>",
  "/web fetch off|on <name>",
  "/web format native|serp|answer",
  "/web excerpts auto|short|long",
  "/web test [all] [query]                probe each backend: latency, size, cost",
  "/web reset                             clear cool-offs",
].join("\n");

function parseNames<T extends string>(words: string[], allowed: readonly T[]): { names: T[]; bad: string[] } {
  const names: T[] = [];
  const bad: string[] = [];
  for (const raw of words.flatMap((w) => w.split(","))) {
    const name = raw.trim().toLowerCase() as T;
    if (!name) continue;
    if (!allowed.includes(name)) bad.push(name);
    else if (!names.includes(name)) names.push(name);
  }
  return { names, bad };
}

async function handleWeb(args: string, ctx: ExtensionContext): Promise<void> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const notify = (msg: string) => ctx.ui.notify(msg, "info");

  if (!words.length) {
    notify(await statusText(await loadConfig()));
    return;
  }

  const [head, ...rest] = words;
  switch (head.toLowerCase()) {
    case "help":
      notify(WEB_HELP);
      return;

    case "reset": {
      await clearSkips();
      notify(`Cool-offs cleared.\n\n${await statusText(await loadConfig())}`);
      return;
    }

    case "test": {
      notify(`Probing ${rest[0]?.toLowerCase() === "all" ? "all backends" : "API backends"}\u2026`);
      notify(await runTest(rest, ctx));
      return;
    }

    case "format": {
      const value = rest[0]?.toLowerCase() as Format;
      if (!FORMATS.includes(value)) {
        notify(`format must be one of: ${FORMATS.join(", ")}`);
        return;
      }
      await mutateConfig((cfg) => {
        cfg.format = value;
      });
      notify(`format \u2192 ${value}`);
      return;
    }

    case "excerpts": {
      const value = rest[0]?.toLowerCase() as Excerpts;
      if (!EXCERPT_MODES.includes(value)) {
        notify(`excerpts must be one of: ${EXCERPT_MODES.join(", ")}`);
        return;
      }
      await mutateConfig((cfg) => {
        cfg.excerpts = value;
      });
      notify(`excerpts \u2192 ${value}`);
      return;
    }

    case "search":
    case "fetch": {
      const which = head.toLowerCase() as "search" | "fetch";
      const allowed = which === "search" ? SEARCH_BACKENDS : FETCH_TIERS;
      const [verb, ...names] = rest;
      const { names: parsed, bad } = parseNames(names, allowed as readonly string[]);
      if (bad.length) {
        notify(`unknown ${which} name(s): ${bad.join(", ")}\nvalid: ${allowed.join(", ")}`);
        return;
      }

      if (verb?.toLowerCase() === "order") {
        if (!parsed.length) {
          notify(`give at least one name: ${allowed.join(", ")}`);
          return;
        }
        const cfg = await mutateConfig((c) => {
          // Names left out keep working but move to the back, so a partial
          // order is a reprioritisation rather than a silent amputation.
          const remainder = (c[which].order as string[]).filter((n) => !parsed.includes(n));
          c[which].order = [...parsed, ...remainder] as any;
        });
        notify(`${which} order \u2192 ${chainLine(cfg[which].order, cfg[which].off, cfg.skipUntil)}`);
        return;
      }

      if (verb?.toLowerCase() === "off" || verb?.toLowerCase() === "on") {
        if (!parsed.length) {
          notify(`give at least one name: ${allowed.join(", ")}`);
          return;
        }
        const turningOff = verb.toLowerCase() === "off";
        const cfg = await mutateConfig((c) => {
          const off = new Set(c[which].off as string[]);
          for (const name of parsed) (turningOff ? off.add(name) : off.delete(name));
          c[which].off = [...off] as any;
        });
        notify(`${which} \u2192 ${chainLine(cfg[which].order, cfg[which].off, cfg.skipUntil)}`);
        return;
      }

      notify(WEB_HELP);
      return;
    }

    default:
      notify(WEB_HELP);
  }
}

/* -------------------------------------------------------------- extension */

export default function web(pi: ExtensionAPI): void {
  pi.registerCommand("web", {
    description: "Configure the web_search backend chain and web_fetch tier ladder",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        "search order",
        "search off",
        "search on",
        "fetch order",
        "fetch off",
        "fetch on",
        "format native",
        "format serp",
        "format answer",
        "excerpts auto",
        "excerpts short",
        "excerpts long",
        "test",
        "test all",
        "reset",
        "help",
      ].map((value) => ({ value, label: value }));
      const filtered = options.filter((o) => o.value.startsWith(prefix));
      return filtered.length ? filtered : null;
    },
    handler: handleWeb,
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Returns ranked results with excerpts; some backends return prose instead. Backend order is operator-configured (/web).",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query" }),
      recency: Type.Optional(Type.String({ description: "Bias to recent sources: day, week, month, or year" })),
      links_only: Type.Optional(
        Type.Boolean({ description: "Skip excerpts, return just a ranked [title](url) list" }),
      ),
      // `enum` rather than a union of literals: TypeBox serialises a union as
      // three separate anyOf branches, which costs ~150 characters of schema
      // in every request for no extra meaning. Validation of the value itself
      // happens below, where an unknown mode has to be handled anyway.
      excerpts: Type.Optional(
        Type.String({
          enum: [...EXCERPT_MODES],
          description: "Excerpt length: short ~200 chars, auto ~1200, long ~2500 when chasing an exact figure.",
        }),
      ),
    }),
    async execute(_id, params: any, signal, onUpdate, ctx) {
      // An out-of-range mode would index EXCERPT_CHARS to undefined and
      // truncate every excerpt to a single ellipsis, so drop it rather than
      // trust the schema to have been enforced upstream.
      const excerpts: Excerpts | undefined = EXCERPT_MODES.includes(params.excerpts)
        ? params.excerpts
        : undefined;
      const outcome = await runSearchChain(
        params.query,
        { recency: params.recency, linksOnly: params.links_only, excerpts },
        {
          codex: (query, opts, s) => codexSearch(query, { recency: opts.recency, linksOnly: opts.linksOnly }, ctx, s),
          onAttempt: (msg) => onUpdate?.({ content: [{ type: "text", text: `Searching ${msg}` }], details: undefined }),
        },
        signal,
      );
      ctx.ui.setStatus("web", chipFor(outcome.backend, outcome.excerpts));
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        details: {
          query: params.query,
          backend: outcome.backend,
          excerpts: outcome.excerpts,
          ...(outcome.searchedAs ? { searchedAs: outcome.searchedAs } : {}),
          tried: outcome.tried,
        },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL as readable markdown. Escalates on failure/bot-challenges: plain fetch → curl with browser headers → headless Chrome. YouTube links return the transcript. Result footer reports which tier succeeded.",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      max_chars: Type.Optional(Type.Number({ description: `Truncation limit (default ${DEFAULT_MAX_CHARS})` })),
    }),
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch "));
      text += theme.fg("accent", String(args.url ?? ""));
      return new Text(text, 0, 0);
    },

    async execute(_id, params: any, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}` }], details: undefined });
      const raw = Number(params.max_chars ?? DEFAULT_MAX_CHARS);
      const maxChars = Number.isFinite(raw)
        ? Math.min(Math.max(Math.trunc(raw), MIN_MAX_CHARS), MAX_MAX_CHARS)
        : DEFAULT_MAX_CHARS;

      const parsed = new URL(params.url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Only http(s) URLs are supported.");
      }

      // YouTube: yt-dlp first (timestamps, metadata); fall back to the warmed
      // browser player-intercept when yt-dlp can't get captions.
      if (isYouTube(parsed)) {
        try {
          const text = await youtubeTranscript(params.url, signal);
          return { content: [{ type: "text" as const, text: truncate(text, maxChars, params.url) }], details: { url: params.url } };
        } catch (err) {
          onUpdate?.({ content: [{ type: "text", text: `yt-dlp failed (${err instanceof Error ? err.message : err}); trying browser transcript...` }], details: undefined });
        }
      }

      const cfg = await loadConfig();
      const order = activeChain(cfg.fetch.order, cfg.fetch.off, cfg.skipUntil) as FetchTierName[];
      // Resolve the key only when the tier is actually in play, so a fetch that
      // never reaches Firecrawl never touches the Keychain.
      const firecrawlKey = order.includes("firecrawl") ? await resolveKey("firecrawl") : undefined;

      const result = await resilientFetch(params.url, {
        maxChars,
        signal,
        order,
        firecrawlKey,
        // Firecrawl bills search and fetch from one pool, so a quota rejection
        // here has to bench it for the search chain too — even when a cheaper
        // tier went on to answer this particular fetch.
        onTierError: (tier, err) => {
          if (tier !== "firecrawl") return;
          const status = (err as { status?: number }).status;
          if (typeof status !== "number") return;
          const cooloff = cooloffForStatus(status, err.message);
          if (cooloff > 0) void markSkip("firecrawl", cooloff);
        },
        onAttempt: (msg) => onUpdate?.({ content: [{ type: "text", text: msg }], details: undefined }),
      });
      return { content: [{ type: "text" as const, text: result.content }], details: { url: params.url, tier: result.tier } };
    },
  });
}
