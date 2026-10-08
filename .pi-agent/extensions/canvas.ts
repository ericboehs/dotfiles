/**
 * Session canvas: a live local web page for each pi session.
 *
 * - One shared daemon (canvas/daemon.mjs) serves http://127.0.0.1:8790, an
 *   index at / and one page per session at /s/<session-id>. It only reads
 *   ~/.pi/canvas/<session-id>/ and pushes changes over server-sent events.
 * - After each settled turn with tool calls, Haiku 5.5 rewrites the status
 *   block (goal, now, done, open, next) from a digest of that turn. In-process
 *   modelRegistry.complete(), the same pattern as auto-session-name.ts; the
 *   main model does nothing.
 * - The `canvas` tool lets the main agent add or replace sections: markdown,
 *   html, html-plan, image, mermaid, and append-only findings.
 * - Safari never opens by itself. `/canvas` opens or focuses this session's
 *   page on display 1, left half.
 *
 * Env: PI_CANVAS=0 disables everything; PI_CANVAS_STATUS=0 keeps the tool but
 * stops status runs; PI_CANVAS_MODEL=provider/id overrides the status model;
 * PI_CANVAS_PORT / PI_CANVAS_ROOT move the daemon. Subagent children
 * (PI_SUBAGENT_CHILD=1) skip the canvas.
 */

import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const PORT = Number(process.env.PI_CANVAS_PORT || 8790);
export const STATUS_MODEL = process.env.PI_CANVAS_MODEL || "github-copilot/claude-haiku-5.5";
const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "canvas", "daemon.mjs");
const PAGE = join(HERE, "canvas", "page.mjs");

const MAX_BODY = 2 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export const canvasRoot = () => resolve(process.env.PI_CANVAS_ROOT || join(homedir(), ".pi", "canvas"));
export const pageUrl = (sessionId: string) => `http://127.0.0.1:${PORT}/s/${encodeURIComponent(sessionId)}`;

// ── pure helpers (tested) ────────────────────────────────────────────────────

export function isSectionId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

export type Turn = {
  user: string;
  tools: { name: string; arg: string; error: boolean }[];
  files: string[];
  reply: string;
};

type Part = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Entry = { type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; toolCallId?: string } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

const oneLine = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The newest user prompt and everything after it on the branch. */
export function lastTurn(branch: unknown[]): Turn {
  const entries = (branch || []) as Entry[];
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]?.message;
    if (entries[i]?.type === "message" && m?.role === "user") {
      const t = textOf(m.content);
      // Messages injected by other agents are not the user's turn.
      if (t.startsWith("[cross-agent") || t.startsWith("[reply from")) continue;
      start = i;
      break;
    }
  }
  const turn: Turn = { user: "", tools: [], files: [], reply: "" };
  if (start < 0) return turn;
  turn.user = textOf(entries[start]?.message?.content);
  const files = new Set<string>();
  const errored = new Set<string>();
  for (const e of entries.slice(start + 1)) {
    const m = e?.message;
    if (e?.type !== "message" || !m) continue;
    if (m.role === "toolResult" && m.isError && m.toolCallId) errored.add(m.toolCallId);
  }
  for (const e of entries.slice(start + 1)) {
    const m = e?.message;
    if (e?.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as (Part & { id?: string })[]) {
      if (p?.type === "text" && p.text?.trim()) turn.reply = p.text.trim();
      if (p?.type !== "toolCall" || !p.name) continue;
      const a = p.arguments ?? {};
      const arg = a.command ?? a.path ?? a.query ?? a.url ?? a.pattern ?? a.id ?? a.op ?? "";
      turn.tools.push({ name: p.name, arg: oneLine(arg, 160), error: Boolean(p.id && errored.has(p.id)) });
      if ((p.name === "edit" || p.name === "write") && typeof a.path === "string") files.add(a.path);
    }
  }
  turn.files = [...files];
  return turn;
}

export type Status = {
  goal: string;
  now: string;
  done: string[];
  open: string[];
  next: string[];
  model?: string;
  at?: string;
  runs?: number;
};

/** Should this turn trigger a status run? Short tool-free chat does not. */
export function worthStatus(turn: Turn): boolean {
  return turn.tools.length > 0 || turn.reply.length >= 400;
}

export function turnDigest(turn: Turn, prev: Status | null, extra: { name?: string; cwd?: string; todo?: string[] } = {}): string {
  const lines: string[] = [];
  lines.push(`Previous status: ${prev ? JSON.stringify({ goal: prev.goal, now: prev.now, done: prev.done, open: prev.open, next: prev.next }) : "none"}`);
  if (extra.name || extra.cwd) lines.push(`Session: ${extra.name || "(unnamed)"} in ${extra.cwd || "?"}`);
  lines.push("", `User said:\n${turn.user.slice(0, 1500)}`);
  if (turn.tools.length) {
    lines.push("", `Tools run (${turn.tools.length}):`);
    for (const t of turn.tools.slice(-25)) lines.push(`- ${t.name}${t.arg ? `: ${t.arg}` : ""}${t.error ? " (failed)" : ""}`);
  }
  if (turn.files.length) lines.push("", `Files changed: ${turn.files.slice(0, 20).join(", ")}`);
  if (extra.todo?.length) lines.push("", "Open tasks:", ...extra.todo.slice(0, 10).map((t) => `- ${t}`));
  lines.push("", `Agent's final reply:\n${turn.reply.slice(0, 2500)}`);
  return lines.join("\n");
}

export const STATUS_PROMPT = [
  "You keep a terse status panel for a coding-agent session.",
  "Given the previous status and the latest turn, reply with JSON only, no prose and no code fence:",
  '{"goal": string, "now": string, "done": string[], "open": string[], "next": string[]}',
  "goal: the overall objective of the session in at most 15 words. Keep the previous goal unless the user clearly changed direction.",
  "now: what the agent just finished or is waiting on, at most 15 words.",
  "done: completed items, newest first, at most 6, merged with the previous list. Each at most 12 words.",
  "open: questions or decisions waiting on the user, at most 4. Drop ones that were answered.",
  "next: at most 3 likely next actions.",
  "Plain text, no markdown. Never include secrets, tokens, passwords or keys.",
].join("\n");

export function parseStatus(text: string): Status | null {
  const raw = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const str = (x: unknown, n: number) => oneLine(typeof x === "string" ? x : "", n);
  const arr = (x: unknown, max: number) =>
    (Array.isArray(x) ? x : [])
      .filter((i) => typeof i === "string" && i.trim())
      .slice(0, max)
      .map((i) => oneLine(i, 160));
  const s: Status = { goal: str(v.goal, 200), now: str(v.now, 200), done: arr(v.done, 6), open: arr(v.open, 4), next: arr(v.next, 3) };
  return s.goal || s.now || s.done.length ? s : null;
}

/** Open, claimed and blocked lines of a project .pi/TODO.md. */
export function openTodos(text: string): string[] {
  return String(text || "")
    .split("\n")
    .filter((l) => /^- \[[ /!]\] /.test(l))
    .map((l) => oneLine(l.slice(2), 140));
}

export type Section = { id: string; title: string; kind: string; file: string; order: number; at: string };

export function upsertSection(list: Section[], sec: Section): Section[] {
  const out = list.filter((s) => s.id !== sec.id);
  out.push(sec);
  return out;
}

export function findingLine(text: string, at = new Date().toISOString()): string {
  const [first, ...rest] = String(text).trim().split("\n");
  return `- [${at}] ${first}${rest.map((l) => `\n  ${l}`).join("")}\n`;
}

/** Display 1 from `wrangle displays`, as AppleScript bounds for its left half. */
export function leftHalfBounds(displays: string, index = 1): [number, number, number, number] | undefined {
  for (const line of displays.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+x=(-?\d+)\s+y=(-?\d+)\s+(\d+)x(\d+)/);
    if (!m || Number(m[1]) !== index) continue;
    const [x, y, w, h] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    return [x, y, x + Math.floor(w / 2), y + h];
  }
  return undefined;
}

// ── files ────────────────────────────────────────────────────────────────────

function writeAtomic(path: string, data: string | Buffer) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// ── daemon ───────────────────────────────────────────────────────────────────

/** Hash of the daemon and page code on disk, so every pi agrees on one version. */
function daemonVersion(): string {
  const h = createHash("sha1");
  for (const f of [DAEMON, PAGE]) {
    try {
      h.update(readFileSync(f));
    } catch {}
  }
  return h.digest("hex").slice(0, 12);
}

async function health(): Promise<{ version?: string; pid?: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok ? ((await res.json()) as { version?: string; pid?: number }) : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let daemonReady: Promise<boolean> | undefined;

/** Start the shared daemon unless a current one answers. Replaces a stale one. */
export function ensureDaemon(): Promise<boolean> {
  daemonReady ??= (async () => {
    const version = daemonVersion();
    const h = await health();
    if (h?.version === version) return true;
    if (h?.pid) {
      try {
        process.kill(h.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 20 && (await health()); i++) await sleep(100);
    }
    const root = canvasRoot();
    mkdirSync(root, { recursive: true });
    const log = openSync(join(root, ".daemon.log"), "a");
    const node = basename(process.execPath).startsWith("node") ? process.execPath : "node";
    const child = spawn(node, [DAEMON, "--port", String(PORT), "--root", root, "--version", version], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, PI_CANVAS_ROOT: root },
    });
    child.unref();
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if ((await health())?.version) return true;
    }
    return false;
  })();
  const attempt = daemonReady;
  // A failed attempt is retried on the next call instead of cached.
  void attempt.then((ok) => {
    if (!ok && daemonReady === attempt) daemonReady = undefined;
  });
  return attempt;
}

// ── safari ───────────────────────────────────────────────────────────────────

const OPEN_SCRIPT = `
on run argv
  set u to item 1 of argv
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (URL of t as text) starts with u then
            set current tab of w to t
            set index of w to 1
            activate
            return "focused"
          end if
        end try
      end repeat
    end repeat
    make new document with properties {URL:u}
    if (count of argv) is 5 then
      set bounds of front window to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}
    end if
    activate
    return "opened"
  end tell
end run`;

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout }, (err, stdout) => res(err ? "" : String(stdout)));
  });
}

async function openInSafari(url: string): Promise<string> {
  const bounds = leftHalfBounds(await run("wrangle", ["displays"]));
  const out = await run("osascript", ["-e", OPEN_SCRIPT, url, ...(bounds ? bounds.map(String) : [])]);
  return out.trim() || "failed";
}

// ── extension ────────────────────────────────────────────────────────────────

type CompleteResult = { stopReason?: string; errorMessage?: string; content?: Part[] };
type Registry = {
  find?: (provider: string, id: string) => unknown;
  hasConfiguredAuth?: (model: unknown) => boolean;
  complete?: (model: unknown, req: unknown, opts: Record<string, unknown>) => Promise<CompleteResult>;
};

const KINDS = ["markdown", "html", "html-plan", "image", "mermaid", "finding"] as const;

export default function canvas(pi: ExtensionAPI) {
  if (process.env.PI_CANVAS === "0" || process.env.PI_SUBAGENT_CHILD === "1") return;

  let sessionId = "";
  let statusOn = process.env.PI_CANVAS_STATUS !== "0";
  let inflight: AbortController | undefined;
  let warned = false;
  let queue: Promise<unknown> = Promise.resolve();

  const dir = () => join(canvasRoot(), sessionId);

  /** Create the folder and meta.json on first write, never for idle sessions. */
  function ensureDir(ctx: ExtensionContext): string {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const metaPath = join(d, "meta.json");
    const prev = readJson<Record<string, unknown>>(metaPath, {});
    const meta = {
      id: sessionId,
      name: pi.getSessionName() || "",
      cwd: ctx.cwd,
      pid: process.pid,
      started: (prev.started as string) || new Date().toISOString(),
    };
    if (JSON.stringify({ ...prev, ended: undefined }) !== JSON.stringify(meta)) writeAtomic(metaPath, JSON.stringify(meta, null, 2));
    return d;
  }

  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  async function refreshStatus(ctx: ExtensionContext, force = false): Promise<string> {
    const turn = lastTurn(ctx.sessionManager.getBranch() || []);
    if (!force && !worthStatus(turn)) return "skipped: short turn";
    const reg = ctx.modelRegistry as unknown as Registry;
    const slash = STATUS_MODEL.indexOf("/");
    const model = slash > 0 ? reg.find?.(STATUS_MODEL.slice(0, slash), STATUS_MODEL.slice(slash + 1)) : undefined;
    if (!model || typeof reg.complete !== "function" || (reg.hasConfiguredAuth && !reg.hasConfiguredAuth(model))) {
      if (!warned && ctx.hasUI) ctx.ui.notify(`canvas: status model ${STATUS_MODEL} is not available; status runs are off`, "warning");
      warned = true;
      return `unavailable: ${STATUS_MODEL}`;
    }
    const d = ensureDir(ctx);
    const prev = readJson<Status | null>(join(d, "status.json"), null);
    let todo: string[] = [];
    try {
      todo = openTodos(readFileSync(join(ctx.cwd, ".pi", "TODO.md"), "utf8"));
    } catch {}
    const digest = turnDigest(turn, prev, { name: pi.getSessionName(), cwd: ctx.cwd, todo });

    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await reg.complete(
        model,
        { systemPrompt: STATUS_PROMPT, messages: [{ role: "user", content: digest }] },
        { maxTokens: 700, cacheRetention: "none", signal: ac.signal, sessionId: randomUUID(), samplingParams: { enable_thinking: false, thinking: { type: "disabled" } } },
      );
      if (ac.signal.aborted) return "aborted";
      if (res?.stopReason === "error" || res?.stopReason === "aborted") return `error: ${res.errorMessage || res.stopReason}`;
      const status = parseStatus(textOf(res?.content));
      if (!status) return "error: unparseable reply";
      // The session may have switched while Haiku ran.
      if (basename(d) !== sessionId) return "stale";
      writeAtomic(join(d, "status.json"), JSON.stringify({ ...status, model: STATUS_MODEL.split("/").pop(), at: new Date().toISOString(), runs: (prev?.runs ?? 0) + 1 }, null, 2));
      return "updated";
    } catch (e) {
      return `error: ${(e as Error).message}`;
    } finally {
      clearTimeout(timer);
      if (inflight === ac) inflight = undefined;
    }
  }

  pi.on("session_start", (_e, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    if (existsSync(dir())) ensureDir(ctx);
    void ensureDaemon();
  });

  pi.on("session_info_changed", (_e, ctx) => {
    if (sessionId && existsSync(dir())) ensureDir(ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || !statusOn || !ctx.hasUI || !sessionId) return;
    void refreshStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    inflight?.abort();
    inflight = undefined;
    if (!sessionId) return;
    const metaPath = join(dir(), "meta.json");
    if (!existsSync(metaPath)) return;
    try {
      writeAtomic(metaPath, JSON.stringify({ ...readJson(metaPath, {}), ended: new Date().toISOString() }, null, 2));
    } catch {}
  });

  pi.registerCommand("canvas", {
    description: "Open this session's live canvas page. Args: on | off | url | status",
    handler: async (args, ctx) => {
      const arg = String(args || "").trim();
      if (arg === "off" || arg === "on") {
        statusOn = arg === "on";
        ctx.ui.notify(`canvas: status runs ${statusOn ? "on" : "off"} for this session`, "info");
        return;
      }
      const url = pageUrl(sessionId);
      if (arg === "url") {
        ctx.ui.notify(url, "info");
        return;
      }
      if (arg === "status") {
        ctx.ui.notify("canvas: refreshing status…", "info");
        ctx.ui.notify(`canvas: ${await refreshStatus(ctx, true)}`, "info");
        return;
      }
      ensureDir(ctx);
      if (!(await ensureDaemon())) {
        ctx.ui.notify(`canvas: daemon did not start; see ${join(canvasRoot(), ".daemon.log")}`, "error");
        return;
      }
      const how = await openInSafari(url);
      ctx.ui.notify(how === "failed" ? `canvas: could not drive Safari; open ${url}` : `canvas: ${how} ${url}`, how === "failed" ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "canvas",
    label: "Canvas",
    description:
      "Show rich output on this session's live web page (the canvas) that the user keeps open beside the terminal. " +
      "Writes one section per call; the same id replaces it. Kinds: markdown (GFM tables, code, ```mermaid fences), " +
      "html (a self-contained page or fragment, shown in a sandboxed frame), html-plan (a packed /html-plan file via path), " +
      "image (png/jpg/gif/webp/svg via path), mermaid (diagram source), finding (appends one durable line to the findings log; id not needed). " +
      "Use remove: true to delete a section. Returns the page URL; it does not open a browser.",
    promptSnippet: "canvas: put tables, diagrams, plans, screenshots and findings on this session's live web page",
    promptGuidelines: [
      "Use canvas for output too wide or long for the terminal: tables over about 6 rows, diagrams, plans, screenshots, comparisons. Still give a short answer in chat.",
      "Use one stable id per topic and replace it as the work changes. Do not stack old versions.",
      "Record a durable fact, decision or gotcha as kind 'finding'.",
      "Never put secrets, tokens or passwords on the canvas.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Stable lowercase slug, e.g. 'hook-points'. Required except for kind 'finding'." })),
      title: Type.Optional(Type.String({ description: "Section heading" })),
      kind: Type.Union(KINDS.map((k) => Type.Literal(k)), { description: "Section kind" }),
      body: Type.Optional(Type.String({ description: "Markdown, HTML, mermaid source or finding text" })),
      path: Type.Optional(Type.String({ description: "File to copy in: packed html-plan, html page, or image. Relative to the cwd." })),
      order: Type.Optional(Type.Number({ description: "Lower sorts higher. Default 100." })),
      remove: Type.Optional(Type.Boolean({ description: "Delete the section with this id" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return serial(async () => {
        if (!sessionId) sessionId = ctx.sessionManager.getSessionId();
        const d = ensureDir(ctx);
        const url = pageUrl(sessionId);
        void ensureDaemon();

        if (params.kind === "finding") {
          const text = String(params.body || params.title || "").trim();
          if (!text) throw new Error("finding needs body text");
          if (text.length > 4000) throw new Error("finding is over 4000 characters; put long material in a markdown section");
          appendFileSync(join(d, "findings.md"), findingLine(text));
          return { content: [{ type: "text" as const, text: `Canvas: finding recorded. Page: ${url}` }], details: { kind: "finding", url } };
        }

        if (!isSectionId(params.id)) throw new Error("id must be a lowercase slug: a-z, 0-9 and '-', at most 64 characters");
        const id = params.id;
        const listPath = join(d, "sections.json");
        let list = readJson<Section[]>(listPath, []);
        const old = list.find((s) => s.id === id);

        if (params.remove) {
          if (old) rmSync(join(d, old.file), { force: true });
          writeAtomic(listPath, JSON.stringify(list.filter((s) => s.id !== id), null, 2));
          return { content: [{ type: "text" as const, text: `Canvas: removed "${id}". Page: ${url}` }], details: { id, removed: true, url } };
        }

        let file: string;
        if (params.path) {
          const src = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
          const st = statSync(src);
          if (!st.isFile()) throw new Error(`${params.path} is not a file`);
          if (st.size > MAX_FILE) throw new Error(`${params.path} is over 20 MB`);
          const ext = extname(src).toLowerCase();
          if (params.kind === "image") {
            if (!IMAGE_EXT.has(ext)) throw new Error(`image must be one of ${[...IMAGE_EXT].join(", ")}`);
            file = `${id}${ext === ".jpeg" ? ".jpg" : ext}`;
          } else if (params.kind === "html" || params.kind === "html-plan") {
            file = `${id}.html`;
          } else if (params.kind === "markdown") {
            file = `${id}.md`;
          } else {
            file = `${id}.mmd`;
          }
          if (old && old.file !== file) rmSync(join(d, old.file), { force: true });
          copyFileSync(src, join(d, `${file}.tmp`));
          renameSync(join(d, `${file}.tmp`), join(d, file));
        } else {
          if (params.kind === "image" || params.kind === "html-plan") throw new Error(`${params.kind} needs path`);
          const body = String(params.body ?? "");
          if (!body.trim()) throw new Error("body is empty");
          if (Buffer.byteLength(body) > MAX_BODY) throw new Error("body is over 2 MB; write a file and pass path");
          file = `${id}.${params.kind === "markdown" ? "md" : params.kind === "mermaid" ? "mmd" : "html"}`;
          if (old && old.file !== file) rmSync(join(d, old.file), { force: true });
          writeAtomic(join(d, file), body);
        }

        const sec: Section = { id, title: params.title || old?.title || id, kind: params.kind, file, order: params.order ?? old?.order ?? 100, at: new Date().toISOString() };
        list = upsertSection(list, sec);
        writeAtomic(listPath, JSON.stringify(list, null, 2));
        return {
          content: [{ type: "text" as const, text: `Canvas: ${old ? "replaced" : "added"} "${id}" (${params.kind}). Page: ${url}#sec-${id}` }],
          details: { id, kind: params.kind, url },
        };
      });
    },
    renderCall(args, theme) {
      const a = args as { id?: string; kind?: string; title?: string; remove?: boolean };
      const what = a.remove ? `remove ${a.id}` : a.kind === "finding" ? "finding" : `${a.kind} ${a.id ?? ""}`;
      return new Text(`${theme.fg("toolTitle", theme.bold("canvas"))} ${theme.fg("muted", what)}${a.title ? theme.fg("dim", ` · ${a.title}`) : ""}`, 0, 0);
    },
  });
}
