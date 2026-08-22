import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

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

interface SearchOptions {
  recency?: string;
  linksOnly?: boolean;
}

async function search(query: string, opts: SearchOptions, ctx: ExtensionContext, signal?: AbortSignal) {
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

  // links mode: the list is the payload, so never append a duplicate source block.
  if (opts.linksOnly) return answer || sources.slice(0, 10).map((u) => `- ${u}`).join("\n");

  const cited = sources.filter((u) => !answer.includes(u)).slice(0, 10);
  return cited.length ? `${answer}\n\nSources:\n${cited.map((u) => `- ${u}`).join("\n")}` : answer;
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

function stripChrome(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|form|iframe|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
}

function textFallback(html: string): string {
  return stripChrome(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function toMarkdown(html: string, signal?: AbortSignal): Promise<string> {
  try {
    const md = await run(
      "pandoc",
      ["-f", "html", "-t", "gfm-raw_html", "--wrap=none", "--strip-comments"],
      stripChrome(html),
      signal,
    );
    return md.replace(/\n{3,}/g, "\n\n").replace(/^:::.*$/gm, "").trim();
  } catch {
    // Say so when the fallback engages — unformatted text after a pandoc
    // regression should not look like the page was always like this.
    return `[web_fetch: pandoc unavailable/failed — unformatted text]\n\n${textFallback(html)}`;
  }
}

async function fetchUrl(url: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only http(s) URLs are supported.");

  if (isYouTube(parsed)) return truncate(await youtubeTranscript(url, signal), maxChars, url);

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,*/*" },
    redirect: "follow",
    signal: signal ? AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const type = res.headers.get("content-type") ?? "";
  let body: string;
  if (type.includes("pdf")) {
    const tmp = `/tmp/pi-web-${Date.now()}.pdf`;
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    try {
      body = await run("pdftotext", ["-layout", tmp, "-"], "", signal);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  } else if (type.includes("html") || type.includes("xml")) {
    body = await toMarkdown(await res.text(), signal);
  } else {
    body = await res.text();
  }

  return truncate(body, maxChars, url);
}

function truncate(body: string, maxChars: number, url: string): string {
  let text = body.trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} of ${text.length} chars — re-fetch with a larger max_chars for more]`;
  }
  return `# ${url}\n\n${text}`;
}

/* -------------------------------------------------------------- extension */

export default function web(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web. Returns a cited answer synthesized from live results.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query" }),
      recency: Type.Optional(Type.String({ description: "Bias to recent sources: day, week, month, or year" })),
      links_only: Type.Optional(
        Type.Boolean({ description: "Skip the summary, return just a ranked [title](url) list" }),
      ),
    }),
    async execute(_id, params: any, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }], details: undefined });
      const text = await search(
        params.query,
        { recency: params.recency, linksOnly: params.links_only },
        ctx,
        signal,
      );
      return { content: [{ type: "text" as const, text }], details: { query: params.query } };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL as readable markdown. YouTube links return the transcript.",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      max_chars: Type.Optional(Type.Number({ description: `Truncation limit (default ${DEFAULT_MAX_CHARS})` })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}` }], details: undefined });
      const raw = Number(params.max_chars ?? DEFAULT_MAX_CHARS);
      const maxChars = Number.isFinite(raw)
        ? Math.min(Math.max(Math.trunc(raw), MIN_MAX_CHARS), MAX_MAX_CHARS)
        : DEFAULT_MAX_CHARS;
      const text = await fetchUrl(params.url, maxChars, signal);
      return { content: [{ type: "text" as const, text }], details: { url: params.url } };
    },
  });
}
