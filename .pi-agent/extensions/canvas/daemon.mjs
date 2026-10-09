#!/usr/bin/env node
// Session canvas daemon. One process per machine, shared by every pi session.
//
//   node daemon.mjs --port 8790 --root ~/.pi/canvas --version <hash>
//
// It only reads. Writers (canvas.ts in each pi process) put files in
// <root>/<session-id>/ and this process watches the tree, serves a page per
// session and pushes "changed" over server-sent events.
//
// Loopback only. Requests must arrive on 127.0.0.1 with a loopback Host header,
// which stops DNS rebinding: a web page cannot read the canvas through a
// hostname that resolves to 127.0.0.1. Other local processes stay trusted.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, watch, writeFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { systemTheme } from "./theme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export const PORT = Number(arg("port", process.env.PI_CANVAS_PORT || "8790"));
export const ROOT = resolve(arg("root", process.env.PI_CANVAS_ROOT || join(homedir(), ".pi", "canvas")));
// Where Omarchy keeps the applied theme (theme/colors.toml + theme.name).
export const OMARCHY = resolve(arg("omarchy", process.env.PI_CANVAS_OMARCHY || join(homedir(), ".local", "state", "omarchy", "current")));
/** agent-link's registry (shared with Claude Code): one <pid>.json per live agent. */
export const PEERS = resolve(arg("peers", process.env.PI_CANVAS_PEERS || join(homedir(), ".claude", "sessions")));
const VERSION = arg("version", "dev");
const RETAIN_DAYS = Number(process.env.PI_CANVAS_RETAIN_DAYS || 30);

// Browser libraries, fetched once from jsdelivr and checked against these
// hashes, then cached under <root>/.vendor. Mermaid alone is 5.5 MB, too heavy
// to commit to a dotfiles repo; the pins keep the download reproducible.
export const VENDOR = {
  "marked.js": { url: "https://cdn.jsdelivr.net/npm/marked@18.1.0/lib/marked.umd.js", sha256: "f424dcb508fdf93e0137a970cfce8f3207ea2e3f37eca5f7556a52875683632a" },
  "purify.js": { url: "https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js", sha256: "2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2" },
  "highlight.js": { url: "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/highlight.min.js", sha256: "8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53" },
  "mermaid.js": { url: "https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js", sha256: "6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2" },
};

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(md|mmd|html|png|jpe?g|gif|webp|svg|patch|txt|chart|term|stats|table|compare|steps|jsonv|timeline)$/;

const TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".mmd": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".chart": "application/json; charset=utf-8",
  ".term": "application/json; charset=utf-8",
  ".stats": "application/json; charset=utf-8",
  ".table": "application/json; charset=utf-8",
  ".compare": "application/json; charset=utf-8",
  ".steps": "application/json; charset=utf-8",
  ".jsonv": "application/json; charset=utf-8",
  ".timeline": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

// html sections run in an opaque-origin frame (no allow-same-origin), so they
// can't reach the page or the daemon's routes. html-plan still runs
// same-origin: its runtime keeps answers in localStorage. For both, the
// boundary is also this CSP: no fetch/XHR/WebSocket anywhere, and
// scripts only inline, from here, or from the two CDNs the /artifact pipeline
// allows. Fonts and styles may load over https.
export const SECTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

// ── reading the tree ─────────────────────────────────────────────────────────

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function newestMtime(dir) {
  // Start from the folder itself: an empty or half-written folder has no
  // files, and 0 would read as "idle since 1970" and get pruned on sight.
  let newest = 0;
  try {
    newest = statSync(dir).mtimeMs;
    for (const name of readdirSync(dir)) {
      try {
        newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
      } catch {}
    }
  } catch {}
  return newest;
}

export function parseFindings(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    // "- [<iso>] text", or "- [<iso> · auto] text" for ones the status model wrote.
    const m = line.match(/^- \[([^\]\s]+)(?: · (\w+))?\] (.*)$/);
    if (m) out.push({ at: m[1], ...(m[2] ? { by: m[2] } : {}), text: m[3] });
    else if (line.startsWith("  ") && out.length) out[out.length - 1].text += "\n" + line.slice(2);
  }
  return out;
}

const ACTIVITY_STATES = new Set(["working", "blocked", "done", "error", "idle"]);

export function sessionState(root, id) {
  const dir = join(root, id);
  const meta = readJson(join(dir, "meta.json"), { id });
  const status = readJson(join(dir, "status.json"), null);
  const sections = readJson(join(dir, "sections.json"), []);
  let findings = [];
  try {
    findings = parseFindings(readFileSync(join(dir, "findings.md"), "utf8"));
  } catch {}
  const live = !meta.ended && pidAlive(meta.pid);
  // pi's program state (working, blocked, done, error, idle), written by
  // canvas.ts. Only meaningful while the pi process is alive; anything
  // unknown, including the older "waiting", reads as done.
  const act = readJson(join(dir, "activity.json"), null);
  const activity = !live ? "ended" : ACTIVITY_STATES.has(act?.state) ? act.state : "done";
  const activityMessage = live && typeof act?.message === "string" ? act.message.slice(0, 200) : "";
  // When the state last changed: the banner compares it with when you last saw the page.
  const activityAt = live && typeof act?.at === "string" ? act.at : undefined;
  return { meta: { ...meta, id }, live, activity, activityMessage, activityAt, status, sections: Array.isArray(sections) ? sections : [], findings, updated: newestMtime(dir) };
}

export function listSessions(root) {
  let names = [];
  try {
    names = readdirSync(root).filter((n) => SESSION_ID.test(n) && !n.startsWith("."));
  } catch {}
  const out = [];
  for (const id of names) {
    try {
      if (!statSync(join(root, id)).isDirectory()) continue;
    } catch {
      continue;
    }
    const s = sessionState(root, id);
    out.push({
      id,
      name: s.meta.name || "",
      cwd: s.meta.cwd || "",
      live: s.live,
      activity: s.activity,
      activityMessage: s.activityMessage,
      activityAt: s.activityAt,
      started: s.meta.started,
      ended: s.meta.ended,
      updated: s.updated,
      now: s.status?.now || "",
      goal: s.status?.goal || "",
      open: Array.isArray(s.status?.open) ? s.status.open.length : 0,
      next: Array.isArray(s.status?.next) ? s.status.next.length : 0,
      done: Array.isArray(s.status?.done) ? s.status.done.length : 0,
      sections: s.sections.length,
      findings: s.findings.length,
    });
  }
  return out.sort((a, b) => Number(b.live) - Number(a.live) || b.updated - a.updated);
}

/** Delete session folders idle for `days` whose pi process is gone. */
export function prune(root, days = RETAIN_DAYS, now = Date.now()) {
  const removed = [];
  if (!(days > 0)) return removed;
  for (const s of listSessions(root)) {
    if (s.live) continue;
    if (now - s.updated < days * 86_400_000) continue;
    try {
      rmSync(join(root, s.id), { recursive: true, force: true });
      removed.push(s.id);
    } catch {}
  }
  return removed;
}

// ── vendor cache ─────────────────────────────────────────────────────────────

const vendorPending = new Map();

async function vendorFile(name) {
  const pin = VENDOR[name];
  if (!pin) return undefined;
  const dir = join(ROOT, ".vendor");
  const path = join(dir, name);
  if (existsSync(path)) return path;
  if (!vendorPending.has(name)) {
    vendorPending.set(
      name,
      (async () => {
        const res = await fetch(pin.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const got = createHash("sha256").update(buf).digest("hex");
        if (got !== pin.sha256) throw new Error(`${name}: sha256 mismatch (${got})`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${path}.tmp`, buf);
        renameSync(`${path}.tmp`, path);
        return path;
      })().finally(() => vendorPending.delete(name)),
    );
  }
  return vendorPending.get(name);
}

// ── http ─────────────────────────────────────────────────────────────────────

export function allowedHost(host, port = PORT) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function loopback(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// Files the page loads from /assets/, read fresh on each request so edits
// show on reload without restarting the daemon.
const JS = "text/javascript; charset=utf-8";
const ASSETS = {
  "/assets/page.mjs": ["page.mjs", JS],
  "/assets/theme.mjs": ["theme.mjs", JS],
  "/assets/nav.mjs": ["nav.mjs", JS],
  "/assets/theme-boot.js": ["theme-boot.js", JS],
  "/assets/themes.json": ["themes.json", "application/json; charset=utf-8"],
};

const SHELL = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canvas</title>
<link rel="icon" href="data:,">
<script src="/assets/theme-boot.js"></script>
<script src="/assets/vendor/marked.js" defer></script>
<script src="/assets/vendor/purify.js" defer></script>
<script src="/assets/page.mjs" type="module"></script>
<body><div id="app"></div></body>
</html>`;

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}

const json = (res, value) => send(res, 200, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });

/** SSE subscribers: key is a session id, or "*" for the index. */
const clients = new Map();

function subscribe(key, req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  req.on("close", () => clients.get(key)?.delete(res));
}

function publish(key, data) {
  for (const res of clients.get(key) || []) res.write(`event: changed\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A named event to every open stream. */
function broadcast(event, data) {
  for (const set of clients.values()) for (const res of set) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── html sections: the design kit and the frame script ─────────────────────────
// The frame is cross-origin to the page, so the page can't measure it: this
// script posts the content's height instead. It also stands in an in-memory
// localStorage, which an opaque origin doesn't have, so pages that use it
// still run (state lasts until reload).
const FRAME_JS = `(function(){
function mem(){var m=new Map();return{getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()},key:function(i){var a=Array.from(m.keys());return i<a.length?a[i]:null},get length(){return m.size}}}
try{window.localStorage}catch(e){try{Object.defineProperty(window,"localStorage",{value:mem(),configurable:true});Object.defineProperty(window,"sessionStorage",{value:mem(),configurable:true})}catch(e2){}}
if(window.parent===window)return;
window.addEventListener("message",function(e){if(e.source!==window.parent||!e.data||!("canvasTheme" in e.data))return;var t=e.data.canvasTheme,s=document.documentElement.style,ks=["--bg","--card","--ink","--dim","--line","--soft","--code","--accent","--ok","--warn","--bad","--c1","--c2","--c3","--c4","--c5","--c6","--c7","--c8"];for(var i=0;i<ks.length;i++){if(t&&t.vars&&t.vars[ks[i]])s.setProperty(ks[i],t.vars[ks[i]]);else s.removeProperty(ks[i])}s.colorScheme=t&&t.mode?t.mode:""});
var last=-1;
function post(){var b=document.body;if(!b)return;var cs=getComputedStyle(b),bottom=0;for(var i=0;i<b.children.length;i++){var k=b.children[i],r=k.getBoundingClientRect();bottom=Math.max(bottom,r.bottom+(parseFloat(getComputedStyle(k).marginBottom)||0))}
bottom+=(parseFloat(cs.paddingBottom)||0)+(parseFloat(cs.marginBottom)||0)+window.scrollY;var h=Math.ceil(bottom);if(h!==last){last=h;window.parent.postMessage({canvasFrame:{height:h}},"*")}}
function start(){post();try{new ResizeObserver(post).observe(document.body)}catch(e){}window.addEventListener("load",post)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();`;

/** An html section with the kit's styles and the frame script put in at the top of its head. */
export function withKit(html, kitCss) {
  const off = /<meta\b[^>]*\bname=["']?canvas-kit["']?[^>]*\bcontent=["']?off\b/i.test(html);
  const tag = `${off ? "" : `<style id="canvas-kit">\n${kitCss}</style>\n`}<script>${FRAME_JS}</script>\n`;
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype\b[^>]*>/i]) {
    const m = html.match(re);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  }
  // A bare fragment: give it a doctype so it renders in standards mode.
  return `<!doctype html>\n${tag}${html}`;
}

// ── clip: put a file itself on the clipboard with clippy ─────────────────────
// The one thing the page can make the daemon do. A file copy keeps its real
// name and path, so it pastes into Slack, Mail or Finder as the file.

/** A name that is safe as the last part of a path: no slashes, no leading dot. */
const safeName = (s) => String(s).replace(/[/\\\0]/g, "_").replace(/^\.+/, "") || "file";

/**
 * What clipping a session file puts on the clipboard: the file the agent
 * changed for a cur- copy (while it still exists), a copy named after it for
 * a diff, else the session file itself. { path } or { copy: [from, name] }, or
 * null when the name is not a file of that session.
 */
export function clipTarget(root, id, name) {
  if (!SESSION_ID.test(id || "") || !FILE_NAME.test(name || "")) return null;
  const dir = join(root, id);
  const file = join(dir, name);
  if (!file.startsWith(root + sep) || !existsSync(file)) return null;
  if (name.startsWith("cur-")) {
    const copies = readJson(join(dir, "auto-copies.json"), {});
    const abs = Object.keys(copies).find((k) => copies[k]?.file === name);
    try {
      if (abs && statSync(abs).isFile()) return { path: abs };
    } catch {}
    return { copy: [file, abs ? safeName(basename(abs)) : name] };
  }
  if (name.startsWith("diff-")) {
    const diffs = readJson(join(dir, "auto-diffs.json"), {});
    const abs = Object.keys(diffs).find((k) => diffs[k]?.patch === name);
    if (abs) return { copy: [file, `${safeName(basename(abs))}.patch`] };
  }
  return { path: file };
}

const CLIPPY = ["clippy", "/opt/homebrew/bin/clippy", "/usr/local/bin/clippy"];

function runClippy(path, i = 0) {
  return new Promise((ok, fail) =>
    execFile(CLIPPY[i], [path], { timeout: 10_000 }, (e, _out, err) => {
      if (!e) return ok();
      if (e.code === "ENOENT" && i + 1 < CLIPPY.length) return runClippy(path, i + 1).then(ok, fail);
      fail(e.code === "ENOENT" ? Object.assign(new Error("clippy is not installed"), { status: 501 }) : new Error(String(err || e.message).trim()));
    }),
  );
}

function clip(req, res, id) {
  // Only this page may ask: a cross-site form or fetch can't send this header
  // without a preflight the daemon never answers, and its Origin won't match.
  const origin = req.headers.origin;
  if (req.headers["x-canvas-clip"] !== "1" || (origin && origin !== `http://${req.headers.host}`)) return send(res, 403, "forbidden");
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1024) req.destroy();
  });
  req.on("end", () => {
    let name = "";
    try {
      name = JSON.parse(body).file;
    } catch {}
    const target = clipTarget(ROOT, id, name);
    if (!target) return send(res, 404, "not found");
    let path = target.path;
    if (target.copy) {
      // A fresh folder each time: the clipboard keeps pointing at the last one.
      const dir = join(tmpdir(), "pi-canvas-clip", String(Date.now()));
      rmSync(dirname(dir), { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      path = join(dir, target.copy[1]);
      copyFileSync(target.copy[0], path);
    }
    runClippy(path).then(
      () => json(res, { ok: true, name: basename(path) }),
      (e) => send(res, e.status || 500, e.message),
    );
  });
}

function handler(req, res) {
  if (!loopback(req.socket.remoteAddress)) return send(res, 403, "forbidden");
  if (!allowedHost(req.headers.host)) return send(res, 421, "misdirected");
  const route = new URL(req.url || "/", `http://127.0.0.1:${PORT}`).pathname.split("/").filter(Boolean);
  if (req.method === "POST" && route.length === 3 && route[0] === "s" && route[2] === "clip" && SESSION_ID.test(route[1])) return clip(req, res, route[1]);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "read only");

  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (url.pathname === "/health") return json(res, { ok: true, version: VERSION, pid: process.pid, root: ROOT });
  if (url.pathname === "/" || (parts[0] === "s" && parts.length === 2 && SESSION_ID.test(parts[1]))) {
    return send(res, 200, SHELL, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP });
  }
  if (ASSETS[url.pathname]) {
    const [file, type] = ASSETS[url.pathname];
    return send(res, 200, readFileSync(join(HERE, file)), { "Content-Type": type });
  }
  if (parts[0] === "assets" && parts[1] === "vendor" && parts.length === 3) {
    vendorFile(parts[2]).then(
      (path) => {
        if (!path) return send(res, 404, "not found");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "max-age=86400" });
        createReadStream(path).pipe(res);
      },
      (e) => send(res, 502, `vendor fetch failed: ${e.message}`),
    );
    return;
  }
  if (url.pathname === "/api/sessions") return json(res, listSessions(ROOT));
  if (url.pathname === "/api/system-theme") return json(res, { theme: readSystemTheme() });
  if (url.pathname === "/api/peers") return json(res, { peers: readPeers() });
  if (url.pathname === "/api/events") return subscribe("*", req, res);
  if (parts[0] === "api" && parts[1] === "s" && SESSION_ID.test(parts[2] || "")) {
    const id = parts[2];
    if (parts.length === 3) return json(res, sessionState(ROOT, id));
    if (parts.length === 4 && parts[3] === "events") return subscribe(id, req, res);
  }
  // Section bodies: /s/<id>/f/<name>, flat names only, never a path.
  if (parts[0] === "s" && parts.length === 4 && parts[2] === "f" && SESSION_ID.test(parts[1]) && FILE_NAME.test(parts[3])) {
    const path = join(ROOT, parts[1], parts[3]);
    if (!path.startsWith(ROOT + sep) || !existsSync(path)) return send(res, 404, "not found");
    const type = TYPES[extname(path)] || "application/octet-stream";
    if (extname(path) === ".html") {
      const sec = readJson(join(ROOT, parts[1], "sections.json"), []).find((s) => s.file === parts[3]);
      if (sec?.kind === "html") return send(res, 200, withKit(readFileSync(path, "utf8"), readFileSync(join(HERE, "kit.css"), "utf8")), { "Content-Type": type, "Content-Security-Policy": SECTION_CSP });
    }
    return send(res, 200, readFileSync(path), { "Content-Type": type, "Content-Security-Policy": SECTION_CSP });
  }
  return send(res, 404, "not found");
}

// ── watch ────────────────────────────────────────────────────────────────────

/**
 * Omarchy: follow the system theme. omarchy-theme-set copies the theme to
 * current/theme (rm + mv, so the folder's inode changes) and then writes
 * current/theme.name. Watch current/ itself, and tell open pages once a whole
 * palette is readable and differs from the last one.
 * Returns { name, colors } for the applied theme, or null (no Omarchy, mid-switch).
 */
export function readSystemTheme(dir = OMARCHY) {
  try {
    const name = existsSync(join(dir, "theme.name")) ? readFileSync(join(dir, "theme.name"), "utf8") : "";
    return systemTheme(readFileSync(join(dir, "theme", "colors.toml"), "utf8"), name);
  } catch {
    return null;
  }
}

/**
 * Live agents for the Agents card's dots: name and status only (no folders,
 * sockets or session ids), and only processes that are still running.
 */
export function readPeers(dir = PEERS) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const peers = [];
  for (const f of files) {
    const s = readJson(join(dir, f), null);
    if (!s || typeof s.name !== "string" || !pidAlive(s.pid)) continue;
    peers.push({ name: s.name, status: typeof s.status === "string" ? s.status.slice(0, 40) : "unknown" });
  }
  return peers;
}

function watchSystemTheme() {
  if (!existsSync(OMARCHY)) return;
  let last = JSON.stringify(readSystemTheme());
  let timer;
  try {
    watch(OMARCHY, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = readSystemTheme();
        if (!now || JSON.stringify(now) === last) return;
        last = JSON.stringify(now);
        broadcast("system-theme", { name: now.name });
      }, 300);
    }).on("error", () => {});
  } catch {}
}

const pending = new Map();

function onChange(relPath) {
  if (!relPath) return;
  const id = relPath.split(/[\\/]/)[0];
  if (!id || id.startsWith(".") || !SESSION_ID.test(id)) return;
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      publish(id, { id });
      publish("*", { id });
    }, 120),
  );
}

export function start() {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, ".daemon.json"), JSON.stringify({ pid: process.pid, port: PORT, version: VERSION, started: new Date().toISOString() }));
  prune(ROOT);
  setInterval(() => prune(ROOT), 6 * 3_600_000).unref();
  // Liveness is a pid check, so a pi that dies without session_shutdown only
  // flips to "ended" on the next poll. Nudge index viewers once a minute.
  setInterval(() => publish("*", { tick: true }), 60_000).unref();
  watch(ROOT, { recursive: true }, (_event, file) => onChange(file ? String(file) : ""));
  watchSystemTheme();
  const server = createServer(handler);
  server.on("error", (e) => {
    // Another daemon won the race for the port: that one serves, this one goes.
    if (e.code === "EADDRINUSE") process.exit(0);
    throw e;
  });
  server.listen(PORT, "127.0.0.1");
  return server;
}

// pi runs this through the ~/.pi/agent/extensions symlink, so argv[1] and
// import.meta.url name the same file by different paths. Compare real paths.
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) start();
