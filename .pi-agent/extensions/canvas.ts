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
 * - The same Haiku call may add up to two findings and one auto- section per
 *   turn. After every turn the page also gets a Files changed table and a
 *   Screenshots gallery of images the agent read, with no model involved.
 * - The `canvas` tool lets the main agent add or replace sections: markdown,
 *   html, html-plan, image, mermaid, and append-only findings.
 * - Safari never opens by itself. `/canvas` opens or focuses this session's
 *   page on display 1, left half.
 *
 * Env: PI_CANVAS=0 disables everything; PI_CANVAS_STATUS=0 keeps the tool but
 * stops status runs; PI_CANVAS_MODEL=provider/id overrides the status model;
 * PI_CANVAS_AUTO=0 stops the auto findings, sections, Files changed and
 * Screenshots widgets; PI_CANVAS_PORT / PI_CANVAS_ROOT move the daemon. Subagent children
 * (PI_SUBAGENT_CHILD=1) skip the canvas.
 */

import { spawn, spawnSync, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  /** Every successful edit or write, in order, for the Files changed widget. */
  ops?: { tool: "edit" | "write"; path: string }[];
  /** Image files the agent read this turn (screenshots it looked at). */
  images?: string[];
  /** Sections the main agent added or replaced with the canvas tool this turn. */
  canvasSections?: number;
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
  const turn: Turn = { user: "", tools: [], files: [], ops: [], images: [], reply: "" };
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
      const failed = Boolean(p.id && errored.has(p.id));
      turn.tools.push({ name: p.name, arg: oneLine(arg, 160), error: failed });
      if ((p.name === "edit" || p.name === "write") && typeof a.path === "string") {
        files.add(a.path);
        if (!failed) turn.ops!.push({ tool: p.name, path: a.path });
      }
      if (p.name === "read" && !failed && typeof a.path === "string" && IMAGE_EXT.has(extname(a.path).toLowerCase()) && !turn.images!.includes(a.path)) turn.images!.push(a.path);
      if (p.name === "canvas" && !failed && a.kind !== "finding" && !a.remove) turn.canvasSections = (turn.canvasSections ?? 0) + 1;
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

export function turnDigest(
  turn: Turn,
  prev: Status | null,
  extra: { name?: string; cwd?: string; todo?: string[]; findings?: string[]; sections?: { id: string; title: string; by?: string }[] } = {},
): string {
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
  lines.push("", "Recent findings (do not repeat these):", ...(extra.findings?.length ? extra.findings.slice(-12).map((f) => `- ${oneLine(f, 200)}`) : ["- none"]));
  lines.push("", "Sections on the page:", ...(extra.sections?.length ? extra.sections.map((x) => `- ${x.id}: ${x.title}${x.by === "auto" ? " (yours)" : " (agent's)"}`) : ["- none"]));
  lines.push("", `Agent's final reply:\n${turn.reply.slice(0, 4000)}`);
  return lines.join("\n");
}

export const STATUS_PROMPT = [
  "You keep a coding-agent session's live web page: a terse status panel, a findings log and reference sections.",
  "Given the previous status and the latest turn, reply with JSON only, no prose and no code fence:",
  '{"goal": string, "now": string, "done": string[], "open": string[], "next": string[], "findings": string[], "section": null | {"id": string, "title": string, "markdown": string}}',
  "goal: the overall objective of the session in at most 15 words. Keep the previous goal unless the user clearly changed direction.",
  "now: what the agent just finished or is waiting on, at most 15 words.",
  "done: completed items, newest first, at most 6, merged with the previous list. Each at most 12 words.",
  "open: questions or decisions waiting on the user, at most 4. Drop ones that were answered.",
  "next: at most 3 likely next actions.",
  "findings: 0 to 2 durable facts learned this turn that someone resuming the work later would need: a root cause, a gotcha, a non-obvious constraint, an API fact, or a decision and its reason. Not progress reports, not plans. Each at most 30 words; `code` allowed. Skip anything already in Recent findings. Usually empty.",
  "section: when the turn produced reference material worth keeping in view, such as a comparison or table, a state or option matrix, a set of commands, or a short design summary, return it as GitHub markdown (tables and ```mermaid fences allowed), at most 2500 characters, with a short title and a lowercase-slug id. To revise one of your own sections, reuse its id. Never copy an agent's section. Otherwise null; most turns are null.",
  "Plain text in status fields, no markdown. Never include secrets, tokens, passwords or keys anywhere.",
].join("\n");

export type Extras = { findings: string[]; section: { id: string; title: string; markdown: string } | null };

/** The findings and section a status reply may carry. Section ids get an auto- prefix. */
export function parseExtras(text: string): Extras {
  const out: Extras = { findings: [], section: null };
  const raw = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (Array.isArray(v.findings)) out.findings = v.findings.filter((f) => typeof f === "string" && f.trim()).slice(0, 2).map((f) => oneLine(f, 400));
  const sec = v.section as Record<string, unknown> | null;
  if (sec && typeof sec === "object" && typeof sec.markdown === "string" && sec.markdown.trim()) {
    const slug = String(sec.id || sec.title || "notes").toLowerCase().replace(/^auto-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "notes";
    out.section = { id: `auto-${slug}`, title: oneLine(sec.title || slug, 80), markdown: sec.markdown.slice(0, 6000) };
  }
  return out;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** New findings that are not already in the log, compared loosely. */
export function newFindings(candidates: string[], existing: string[]): string[] {
  const seen = new Set(existing.map(norm));
  const out: string[] = [];
  for (const c of candidates) {
    const n = norm(c);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(c);
  }
  return out;
}

export type FileStat = { edits: number; writes: number; at: string };

/** Fold this turn's edits and writes into the running per-file tally. */
export function tallyFiles(prev: Record<string, FileStat>, ops: { tool: "edit" | "write"; path: string }[], cwd: string, at = new Date().toISOString()) {
  const next = { ...prev };
  for (const op of ops) {
    const abs = isAbsolute(op.path) ? op.path : resolve(cwd, op.path);
    const cur = next[abs] ?? { edits: 0, writes: 0, at };
    next[abs] = { edits: cur.edits + (op.tool === "edit" ? 1 : 0), writes: cur.writes + (op.tool === "write" ? 1 : 0), at };
  }
  return next;
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A path as the page shows it: relative to the session's folder, else ~/…. */
export function displayPath(abs: string, cwd: string): string {
  const home = homedir();
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

// ── diffs: what the session changed in each file it edited or wrote ─────────────
// Before the first edit or write to a file, its contents are copied to
// base-<id> (none for a new file). After each turn, diff-<id>.patch holds the
// change from that base to the file as it is now.

export type DiffEntry = { base: string | null; patch: string; skip?: string; adds?: number; dels?: number };
const MAX_BASE = 1024 * 1024;
const MAX_PATCH = 512 * 1024;

/** Files whose contents never get copied onto the page. */
export function isSensitivePath(p: string): boolean {
  const name = basename(p).toLowerCase();
  return (
    /^\.env(\..*)?$|^\.netrc$|^\.npmrc$|\.(pem|key|p12|pfx|jks|keystore|kdbx)$|^id_(rsa|dsa|ecdsa|ed25519)/.test(name) ||
    /(^|[._-])(secrets?|credentials?|passwords?|passwd|tokens?|api[_-]?keys?)([._-]|$)/.test(name) ||
    /(^|\/)\.(ssh|aws|gnupg|kube)\//.test(p)
  );
}

/** Why a file gets no diff, or "" when it can have one (a missing file is new). */
export function diffSkipReason(p: string): string {
  if (isSensitivePath(p)) return "sensitive";
  try {
    const st = statSync(p);
    if (!st.isFile()) return "not a file";
    if (st.size > MAX_BASE) return "too large";
    if (readFileSync(p).subarray(0, 8192).includes(0)) return "binary";
  } catch {}
  return "";
}

/** A unified diff from base (null: nothing) to the file now, under the display path. */
export function makePatch(basePath: string | null, cur: string, label: string): { patch: string; adds: number; dels: number } {
  const a = basePath ?? "/dev/null";
  const b = existsSync(cur) ? cur : "/dev/null";
  if (a === "/dev/null" && b === "/dev/null") return { patch: "", adds: 0, dels: 0 };
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--", a, b], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr || "git diff failed");
  const out = r.stdout || "";
  const at = out.search(/^@@/m);
  const body = at < 0 ? "" : out.slice(at);
  let adds = 0;
  let dels = 0;
  for (const l of body.split("\n")) {
    if (l.startsWith("+")) adds++;
    else if (l.startsWith("-")) dels++;
  }
  let patch = body ? `--- ${a === "/dev/null" ? a : `a/${label}`}\n+++ ${b === "/dev/null" ? b : `b/${label}`}\n${body}` : "";
  if (patch.length > MAX_PATCH) patch = `${patch.slice(0, MAX_PATCH)}\n\\ diff cut at ${MAX_PATCH / 1024} KB\n`;
  return { patch, adds, dels };
}

// ── the diff kind ────────────────────────────────────────────────────────────

/** A plain ref, "staged", or a range; never starts with "-", so never reads as an option. */
const DIFF_REF = /^(staged|[A-Za-z0-9_][A-Za-z0-9._/@^~{}:-]*(\.\.\.?[A-Za-z0-9_][A-Za-z0-9._/@^~{}:-]*)?)$/;

/** Drop the files of a git patch whose paths look like they hold secrets. */
export function dropSensitive(patch: string): { patch: string; dropped: string[] } {
  const dropped: string[] = [];
  const parts = patch.split(/^(?=diff --git )/m).filter((part) => {
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!m || !(isSensitivePath(m[1] ?? "") || isSensitivePath(m[2] ?? ""))) return true;
    dropped.push(m[2] ?? "");
    return false;
  });
  return { patch: parts.join(""), dropped };
}

/**
 * git diff in repo against ref (HEAD by default; "staged" for the index; a
 * commit or a range), limited to paths. A path git doesn't track shows as a new
 * file. Secret-looking files are dropped and listed.
 */
export function gitDiff(repo: string, ref = "HEAD", paths: string[] = []): { patch: string; dropped: string[] } {
  if (!DIFF_REF.test(ref)) throw new Error(`ref "${ref}" is not a plain ref, a range or "staged"`);
  const top = spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new Error(`${repo} is not inside a git repository`);
  const root = top.stdout.trim();
  const abs = paths.map((p) => (isAbsolute(p) ? p : resolve(repo, p)));
  const opts = { encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024 };
  const git = ["-c", "core.quotepath=off", "-C", root];
  const r = spawnSync("git", [...git, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", ...(ref === "staged" ? ["--cached"] : [ref]), "--", ...abs], opts);
  if (r.status !== 0) throw new Error((r.stderr || "git diff failed").trim());
  let patch = r.stdout;
  if (ref !== "staged" && !ref.includes("..")) {
    for (const p of abs) {
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      if (spawnSync("git", [...git, "ls-files", "--error-unmatch", "--", p]).status === 0) continue;
      // relative to the real path: git's toplevel has symlinks resolved (/var → /private/var).
      const n = spawnSync("git", [...git, "diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", relative(root, realpathSync(p))], opts);
      if (n.status === 1) patch += n.stdout;
    }
  }
  return dropSensitive(patch);
}

/** A changed file's name in the session folder: the first 12 hex of sha1(path). */
export const fileId = (abs: string) => createHash("sha1").update(abs).digest("hex").slice(0, 12);

/** A copy of a changed file as it is now, for the page's File tab, or why there is none. */
export type CopyEntry = { file: string; mtimeMs: number; size: number } | { skip: string };

/**
 * Bring the copies in d up to date with the files at paths: copy any that are
 * new or changed since last time, drop any now deleted or unfit (sensitive,
 * binary, over 1 MB, not a file).
 */
export function syncCopies(d: string, paths: string[], prev: Record<string, CopyEntry>): Record<string, CopyEntry> {
  const next = { ...prev };
  for (const abs of paths) {
    const file = `cur-${fileId(abs)}.txt`;
    let st;
    try {
      st = statSync(abs);
    } catch {}
    const skip = st ? diffSkipReason(abs) : "deleted";
    if (skip || !st) {
      rmSync(join(d, file), { force: true });
      next[abs] = { skip: skip || "deleted" };
      continue;
    }
    const was = prev[abs];
    if (was && "file" in was && was.mtimeMs === st.mtimeMs && was.size === st.size && existsSync(join(d, file))) continue;
    try {
      copyFileSync(abs, join(d, `${file}.tmp`));
      renameSync(join(d, `${file}.tmp`), join(d, file));
      next[abs] = { file, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      next[abs] = { skip: "unreadable" };
    }
  }
  return next;
}

/** Whether text reads as a unified diff at all. */
export const looksLikeDiff = (text: string) => /^(@@ -\d|diff --git |Binary files )/m.test(text);

export function filesMarkdown(
  files: Record<string, FileStat>,
  cwd: string,
  max = 40,
  links: { diffs: Record<string, DiffEntry>; copies?: Record<string, CopyEntry>; sessionId: string } = { diffs: {}, sessionId: "" },
): string {
  const rows = Object.entries(files).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const what = (f: FileStat) => [f.writes ? (f.writes === 1 ? "written" : `written ${f.writes}×`) : "", f.edits ? `${f.edits} edit${f.edits === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  const cell = (abs: string) => {
    const code = `\`${displayPath(abs, cwd).replace(/\|/g, "\\|")}\``;
    const e = links.diffs[abs];
    const c = links.copies?.[abs];
    const hasDiff = !!e && !e.skip && e.adds !== undefined;
    const copy = c && "file" in c ? c.file : "";
    if (!hasDiff && !copy) return code;
    // The link names one file; "#diff" on a copy's link tells the page a diff exists too.
    const f = (name: string) => `/s/${encodeURIComponent(links.sessionId)}/f/${encodeURIComponent(name)}`;
    return `[${code}](${copy ? f(copy) + (hasDiff ? "#diff" : "") : f(e!.patch)})`;
  };
  const delta = (abs: string) => {
    const e = links.diffs[abs];
    if (e?.skip) return ` · no diff (${e.skip})`;
    return e?.adds === undefined ? "" : ` · +${e.adds}\u00a0−${e.dels}`;
  };
  const lines = ["| File | Changes | Last |", "|---|---|---|", ...rows.slice(0, max).map(([abs, f]) => `| ${cell(abs)} | ${what(f)}${delta(abs)} | ${clockTime(f.at)} |`)];
  if (rows.length > max) lines.push("", `…and ${rows.length - max} more`);
  return lines.join("\n");
}

export type Shot = { file: string; name: string; at: string };

export function shotsMarkdown(shots: Shot[], sessionId: string): string {
  const src = (f: string) => `/s/${encodeURIComponent(sessionId)}/f/${encodeURIComponent(f)}`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<div class="gallery">${shots.map((x) => `<figure><a href="${src(x.file)}"><img src="${src(x.file)}" alt="${esc(x.name)}" loading="lazy"></a><figcaption>${esc(x.name)} · ${clockTime(x.at)}</figcaption></figure>`).join("")}</div>`;
}

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

/** The page sorts sections by `at`, newest first; `order` is only in old files. */
export type Section = { id: string; title: string; kind: string; file: string; at: string; by?: "auto"; order?: number };

export function upsertSection(list: Section[], sec: Section): Section[] {
  const out = list.filter((s) => s.id !== sec.id);
  out.push(sec);
  return out;
}

/** The text of each finding in findings.md, without timestamps. */
export function findingTexts(md: string): string[] {
  const out: string[] = [];
  for (const line of String(md || "").split("\n")) {
    const m = line.match(/^- \[[^\]]+\] (.*)$/);
    if (m) out.push(m[1] ?? "");
    else if (line.startsWith("  ") && out.length) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

export function findingLine(text: string, at = new Date().toISOString(), by?: "auto"): string {
  const [first, ...rest] = String(text).trim().split("\n");
  return `- [${at}${by ? ` · ${by}` : ""}] ${first}${rest.map((l) => `\n  ${l}`).join("")}\n`;
}

/** Display 1 from `wrangle displays`, as AppleScript bounds for its left half. */
// ── activity: pi's own program states (OSC 7501), mirrored for the page ─────

export type ActivityState = "working" | "blocked" | "done" | "error" | "idle";
export type Activity = { state: ActivityState; message?: string };

const firstLine = (text: unknown) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) || "";

/**
 * Follows the same events and rules as pi 1.1.0's ProgramStatusReporter, so
 * the page agrees with the terminal: `working` during a run or compaction,
 * `blocked` while a dialog waits, then `done`, `error` or `idle` once the run
 * settles. Messages are dialog titles and first error lines only, never
 * prompts or model output.
 */
export class ActivityTracker {
  private runActive = false;
  private compacting = false;
  private runResult: Activity = { state: "done" };
  private resting: Activity = { state: "idle" };
  private readonly dialogs: { kind: string; title: string }[] = [];

  handle(event: { type: string; [k: string]: any }): void {
    switch (event.type) {
      case "agent_start":
        this.runActive = true;
        this.compacting = false;
        this.runResult = { state: "done" };
        break;
      case "message_end": {
        // The latest response decides, so a retried error gives way to its retry.
        const m = event.message;
        if (m?.role !== "assistant") return;
        this.runResult = m.stopReason === "error" ? { state: "error", message: firstLine(m.errorMessage) } : { state: "done" };
        break;
      }
      case "session_before_compact":
        this.compacting = true;
        break;
      case "session_compact":
        this.compacting = false;
        if (!this.runActive && event.reason === "manual") this.resting = { state: "done" };
        break;
      case "session_compact_failed":
        this.compacting = false;
        if (this.runActive) {
          if (event.aborted) this.runResult = { state: "idle" };
          else if (event.errorMessage) this.runResult = { state: "error", message: firstLine(event.errorMessage) };
        } else if (event.aborted) this.resting = { state: "idle" };
        else if (event.reason === "manual") this.resting = { state: "error", message: firstLine(event.errorMessage) };
        break;
      case "agent_settled":
        this.runActive = false;
        this.compacting = false;
        this.resting = event.aborted ? { state: "idle" } : this.runResult;
        break;
      case "ui_prompt_start":
        this.dialogs.push({ kind: String(event.kind || ""), title: firstLine(event.title) });
        break;
      case "ui_prompt_end": {
        const title = firstLine(event.title);
        let i = this.dialogs.findLastIndex((d) => d.kind === String(event.kind || "") && d.title === title);
        if (i < 0) i = this.dialogs.length - 1;
        if (i >= 0) this.dialogs.splice(i, 1);
        break;
      }
    }
  }

  current(): Activity {
    const dialog = this.dialogs.at(-1);
    if (dialog) return { state: "blocked", ...(dialog.title ? { message: dialog.title } : {}) };
    if (this.compacting) return { state: "working", message: "Compacting context" };
    if (this.runActive) return { state: "working" };
    return this.resting;
  }
}

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

const KINDS = ["markdown", "html", "html-plan", "image", "mermaid", "diff", "finding"] as const;

export default function canvas(pi: ExtensionAPI) {
  if (process.env.PI_CANVAS === "0" || process.env.PI_SUBAGENT_CHILD === "1") return;

  let sessionId = "";
  let statusOn = process.env.PI_CANVAS_STATUS !== "0";
  const autoOn = process.env.PI_CANVAS_AUTO !== "0";
  let inflight: AbortController | undefined;
  const tracker = new ActivityTracker();
  let lastActivity = "";
  let warned = false;
  let queue: Promise<unknown> = Promise.resolve();

  const dir = () => join(canvasRoot(), sessionId);

  /** Write pi's current program state for the page, when it changed. */
  function writeActivity(force = false) {
    if (!sessionId || !existsSync(dir())) return;
    const a = tracker.current();
    const key = JSON.stringify(a);
    if (!force && key === lastActivity) return;
    lastActivity = key;
    try {
      writeAtomic(join(dir(), "activity.json"), JSON.stringify({ ...a, at: new Date().toISOString() }));
    } catch {}
  }

  /** Create the folder and meta.json on first write, never for idle sessions. */
  function ensureDir(ctx: ExtensionContext): string {
    const d = dir();
    const fresh = !existsSync(join(d, "activity.json"));
    mkdirSync(d, { recursive: true });
    if (fresh) writeActivity(true);
    const metaPath = join(d, "meta.json");
    const prev = readJson<Record<string, unknown>>(metaPath, {});
    const meta = {
      id: sessionId,
      name: pi.getSessionName() || "",
      cwd: ctx.cwd,
      pid: process.pid,
      started: (prev.started as string) || new Date().toISOString(),
    };
    // Compare against prev as stored: a stale "ended" from an earlier
    // shutdown must count as a change, so the page shows live again.
    if (JSON.stringify(prev) !== JSON.stringify(meta)) writeAtomic(metaPath, JSON.stringify(meta, null, 2));
    return d;
  }

  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  /** Add or replace a markdown section; skips identical rewrites so the page does not flash. */
  function putMarkdown(d: string, sec: { id: string; title: string; body: string; by?: "auto" }): boolean {
    const listPath = join(d, "sections.json");
    const list = readJson<Section[]>(listPath, []);
    const old = list.find((x) => x.id === sec.id);
    const file = `${sec.id}.md`;
    try {
      if (old && old.file === file && old.title === sec.title && readFileSync(join(d, file), "utf8") === sec.body) return false;
    } catch {}
    if (old && old.file !== file) rmSync(join(d, old.file), { force: true });
    writeAtomic(join(d, file), sec.body);
    const entry: Section = { id: sec.id, title: sec.title, kind: "markdown", file, at: new Date().toISOString(), ...(sec.by ? { by: sec.by } : {}) };
    writeAtomic(listPath, JSON.stringify(upsertSection(list, entry), null, 2));
    return true;
  }

  const AUTO_SECTIONS_KEPT = 6;
  const WIDGETS = new Set(["auto-files", "auto-screenshots"]);

  /** Record Haiku's findings and section, then trim old auto sections. */
  function applyExtras(d: string, extras: Extras, known: string[], agentWroteSection: boolean) {
    for (const f of newFindings(extras.findings, known)) appendFileSync(join(d, "findings.md"), findingLine(f, new Date().toISOString(), "auto"));
    // When the main agent already put this turn's material on the page, a
    // Haiku section would only repeat it.
    if (!extras.section || agentWroteSection) return;
    const listPath = join(d, "sections.json");
    const current = readJson<Section[]>(listPath, []);
    const taken = current.find((x) => x.id === extras.section!.id);
    // Never overwrite a section the main agent wrote, even under an auto- id,
    // and never echo one under another id.
    if (taken && taken.by !== "auto") return;
    if (current.some((x) => x.by !== "auto" && norm(x.title) === norm(extras.section!.title))) return;
    putMarkdown(d, { id: extras.section.id, title: extras.section.title, body: extras.section.markdown, by: "auto" });
    const list = readJson<Section[]>(listPath, []);
    const auto = list.filter((x) => x.by === "auto" && !WIDGETS.has(x.id)).sort((a, b) => b.at.localeCompare(a.at));
    const drop = new Set(auto.slice(AUTO_SECTIONS_KEPT).map((x) => x.id));
    if (!drop.size) return;
    for (const x of list) if (drop.has(x.id)) rmSync(join(d, x.file), { force: true });
    writeAtomic(listPath, JSON.stringify(list.filter((x) => !drop.has(x.id)), null, 2));
  }

  const SHOTS_KEPT = 12;

  /** Before the first edit or write to a file, keep what it held so the page can diff it. */
  function snapshotBase(ctx: ExtensionContext, raw: string) {
    const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
    const d = ensureDir(ctx);
    const idxPath = join(d, "auto-diffs.json");
    const idx = readJson<Record<string, DiffEntry>>(idxPath, {});
    if (idx[abs]) return;
    const id = fileId(abs);
    const skip = diffSkipReason(abs);
    let base: string | null = null;
    if (!skip && existsSync(abs)) {
      base = `base-${id}`;
      copyFileSync(abs, join(d, `${base}.tmp`));
      renameSync(join(d, `${base}.tmp`), join(d, base));
    }
    idx[abs] = { base, patch: `diff-${id}.patch`, ...(skip ? { skip } : {}) };
    writeAtomic(idxPath, JSON.stringify(idx, null, 2));
  }

  /** Files changed and Screenshots: plain bookkeeping from the turn's tool calls. */
  function updateWidgets(ctx: ExtensionContext, turn: Turn) {
    const ops = turn.ops ?? [];
    const images = (turn.images ?? []).map((p) => (isAbsolute(p) ? p : resolve(ctx.cwd, p))).filter((p) => {
      try {
        const st = statSync(p);
        return st.isFile() && st.size <= MAX_FILE;
      } catch {
        return false;
      }
    });
    // Files changed refreshes every turn once it exists: files also change by
    // shell commands, and a turn without edits still brings old rows up to date.
    const tracked = existsSync(join(dir(), "auto-files.json"));
    if (!ops.length && !images.length && !tracked) return;
    const d = ensureDir(ctx);
    if (ops.length || tracked) {
      const path = join(d, "auto-files.json");
      const files = tallyFiles(readJson<Record<string, FileStat>>(path, {}), ops, ctx.cwd);
      if (ops.length) writeAtomic(path, JSON.stringify(files, null, 2));
      const idxPath = join(d, "auto-diffs.json");
      const idx = readJson<Record<string, DiffEntry>>(idxPath, {});
      for (const abs of Object.keys(files)) {
        const e = idx[abs];
        if (!e || e.skip) continue;
        try {
          const { patch, adds, dels } = makePatch(e.base ? join(d, e.base) : null, abs, displayPath(abs, ctx.cwd));
          writeAtomic(join(d, e.patch), patch);
          idx[abs] = { ...e, adds, dels };
        } catch {}
      }
      if (Object.keys(idx).length) writeAtomic(idxPath, JSON.stringify(idx, null, 2));
      // Every listed file, not just this turn's: files changed before copies existed get one too.
      const copiesPath = join(d, "auto-copies.json");
      const copies = syncCopies(d, Object.keys(files), readJson<Record<string, CopyEntry>>(copiesPath, {}));
      writeAtomic(copiesPath, JSON.stringify(copies, null, 2));
      putMarkdown(d, { id: "auto-files", title: "Files changed", body: filesMarkdown(files, ctx.cwd, 40, { diffs: idx, copies, sessionId }), by: "auto" });
    }
    if (images.length) {
      const path = join(d, "auto-shots.json");
      let shots = readJson<Shot[]>(path, []);
      for (const src of images) {
        const ext = extname(src).toLowerCase().replace(".jpeg", ".jpg");
        const file = `shot-${createHash("sha1").update(src).update(String(statSync(src).mtimeMs)).digest("hex").slice(0, 12)}${ext}`;
        if (!existsSync(join(d, file))) {
          copyFileSync(src, join(d, `${file}.tmp`));
          renameSync(join(d, `${file}.tmp`), join(d, file));
        }
        shots = [{ file, name: basename(src), at: new Date().toISOString() }, ...shots.filter((x) => x.file !== file)];
      }
      for (const x of shots.slice(SHOTS_KEPT)) rmSync(join(d, x.file), { force: true });
      shots = shots.slice(0, SHOTS_KEPT);
      writeAtomic(path, JSON.stringify(shots, null, 2));
      putMarkdown(d, { id: "auto-screenshots", title: "Screenshots", body: shotsMarkdown(shots, sessionId), by: "auto" });
    }
  }

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
    let known: string[] = [];
    try {
      known = findingTexts(readFileSync(join(d, "findings.md"), "utf8"));
    } catch {}
    const sections = readJson<Section[]>(join(d, "sections.json"), [])
      .filter((x) => !WIDGETS.has(x.id))
      .map((x) => ({ id: x.id, title: x.title, by: x.by }));
    const digest = turnDigest(turn, prev, { name: pi.getSessionName(), cwd: ctx.cwd, todo, ...(autoOn ? { findings: known, sections } : {}) });

    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await reg.complete(
        model,
        { systemPrompt: STATUS_PROMPT, messages: [{ role: "user", content: digest }] },
        { maxTokens: autoOn ? 2000 : 700, cacheRetention: "none", signal: ac.signal, sessionId: randomUUID(), samplingParams: { enable_thinking: false, thinking: { type: "disabled" } } },
      );
      if (ac.signal.aborted) return "aborted";
      if (res?.stopReason === "error" || res?.stopReason === "aborted") return `error: ${res.errorMessage || res.stopReason}`;
      const status = parseStatus(textOf(res?.content));
      if (!status) return "error: unparseable reply";
      // The session may have switched while Haiku ran.
      if (basename(d) !== sessionId) return "stale";
      writeAtomic(join(d, "status.json"), JSON.stringify({ ...status, model: STATUS_MODEL.split("/").pop(), at: new Date().toISOString(), runs: (prev?.runs ?? 0) + 1 }, null, 2));
      if (autoOn) await serial(() => applyExtras(d, parseExtras(textOf(res?.content)), known, (turn.canvasSections ?? 0) > 0));
      return "updated";
    } catch (e) {
      return `error: ${(e as Error).message}`;
    } finally {
      clearTimeout(timer);
      if (inflight === ac) inflight = undefined;
    }
  }

  pi.on("session_start", (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    if (existsSync(dir())) {
      ensureDir(ctx);
      // A reload keeps the session and whatever state it was in; any other
      // start begins idle, as pi's own status does.
      if (event.reason !== "reload") writeActivity(true);
    }
    void ensureDaemon();
  });

  pi.on("session_info_changed", (_e, ctx) => {
    if (sessionId && existsSync(dir())) ensureDir(ctx);
  });

  const track = (event: { type: string }) => {
    tracker.handle(event);
    writeActivity();
  };
  pi.on("agent_start", track);
  pi.on("message_end", track);
  pi.on("session_before_compact", track);
  pi.on("session_compact", track);
  pi.on("session_compact_failed", track);
  pi.on("ui_prompt_start", track);
  pi.on("ui_prompt_end", track);

  // Never throw here: a failing tool_call handler blocks the tool.
  pi.on("tool_call", (event, ctx) => {
    try {
      if (!autoOn || !ctx.hasUI || !sessionId || (event.toolName !== "edit" && event.toolName !== "write")) return;
      const p = (event.input as { path?: unknown }).path;
      if (typeof p === "string" && p) snapshotBase(ctx, p);
    } catch {}
  });

  pi.on("agent_settled", (event, ctx) => {
    track(event);
    if (!ctx.hasUI || !sessionId) return;
    if (autoOn) {
      const turn = lastTurn(ctx.sessionManager.getBranch() || []);
      void serial(() => updateWidgets(ctx, turn)).catch(() => {});
    }
    if (event.aborted || !statusOn) return;
    void refreshStatus(ctx);
  });

  pi.on("session_shutdown", (event) => {
    inflight?.abort();
    inflight = undefined;
    // /reload keeps the same session in the same process; it is not an end.
    if (!sessionId || event.reason === "reload") return;
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
      "image (png/jpg/gif/webp/svg via path), mermaid (diagram source), " +
      "diff (a unified patch in body or path, or omit both and pass ref/paths to have git produce it; shown GitHub-style, one block per file, with a split view), finding (appends one durable line to the findings log; id not needed). " +
      "Use remove: true to delete a section. Returns the page URL; it does not open a browser.",
    promptSnippet: "canvas: put tables, diagrams, plans, screenshots and findings on this session's live web page",
    promptGuidelines: [
      "The user keeps the canvas open beside the terminal and expects it to grow as you work. Use canvas proactively, without being asked.",
      "Record a finding the moment you confirm a root cause, a gotcha, a non-obvious constraint or API fact, or a decision and its reason. Not progress updates.",
      "When a reply would contain a table, an option or state matrix, a diagram, a plan or a list of commands, put it on the canvas as its own section and keep the chat answer short.",
      "Start a new section for each new topic, with a stable id; replace that id as the topic changes instead of stacking versions.",
      "After verifying UI work with screenshots, add the one that shows the result as an image section.",
      "Sections with ids starting auto- are maintained automatically (Files changed, Screenshots, Haiku notes); leave them alone.",
      "Never put secrets, tokens or passwords on the canvas.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Stable lowercase slug, e.g. 'hook-points'. Required except for kind 'finding'." })),
      title: Type.Optional(Type.String({ description: "Section heading" })),
      kind: Type.Union(KINDS.map((k) => Type.Literal(k)), { description: "Section kind" }),
      body: Type.Optional(Type.String({ description: "Markdown, HTML, mermaid source or finding text" })),
      path: Type.Optional(Type.String({ description: "File to copy in: packed html-plan, html page, image, or a patch for diff. Relative to the cwd." })),
      ref: Type.Optional(Type.String({ description: 'diff without body/path: what git compares the working tree to. Default HEAD; a commit; a range like main..branch; or "staged".' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "diff without body/path: only these files (untracked ones show as new). Default: every change." })),
      repo: Type.Optional(Type.String({ description: "diff without body/path: the repository directory. Default the cwd." })),
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
        let note = "";
        if (params.kind === "diff") {
          let patch: string;
          if (params.path || params.body) {
            if (params.ref || params.paths?.length) throw new Error("diff takes body or path, or ref/paths, not both");
            if (params.path) {
              const src = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
              if (statSync(src).size > MAX_BODY) throw new Error(`${params.path} is over 2 MB`);
              patch = readFileSync(src, "utf8");
            } else patch = String(params.body);
          } else {
            const repo = params.repo ? (isAbsolute(params.repo) ? params.repo : resolve(ctx.cwd, params.repo)) : ctx.cwd;
            const got = gitDiff(repo, params.ref || "HEAD", params.paths ?? []);
            patch = got.patch;
            if (got.dropped.length) note = ` Left out as possibly secret: ${got.dropped.join(", ")}.`;
            if (!patch.trim()) throw new Error(`git diff ${params.ref || "HEAD"} found no changes${params.paths?.length ? " in those paths" : ""}.${note}`);
          }
          if (!looksLikeDiff(patch)) throw new Error("that isn't a unified diff (no @@ hunks)");
          if (Buffer.byteLength(patch) > MAX_BODY) throw new Error("the diff is over 2 MB; narrow it with paths");
          file = `${id}.patch`;
          if (old && old.file !== file) rmSync(join(d, old.file), { force: true });
          writeAtomic(join(d, file), patch);
        } else if (params.path) {
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

        const sec: Section = { id, title: params.title || old?.title || id, kind: params.kind, file, at: new Date().toISOString() };
        list = upsertSection(list, sec);
        writeAtomic(listPath, JSON.stringify(list, null, 2));
        return {
          content: [{ type: "text" as const, text: `Canvas: ${old ? "replaced" : "added"} "${id}" (${params.kind}). Page: ${url}#sec-${id}${note}` }],
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
