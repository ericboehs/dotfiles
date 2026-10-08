// Session canvas page. Served by daemon.mjs at / (index) and /s/<id>.
// Re-fetches state on each server-sent "changed" event and re-renders only the
// sections whose timestamp moved, so iframes and scroll position survive.

const CSS = `
:root { color-scheme: light dark; --bg:#f7f5f0; --card:#fff; --ink:#1c1b19; --dim:#8a8578; --line:#e6e1d6; --soft:#f0ece3; --accent:#b4541f; --ok:#1f7a52; --warn:#a86a00; --bad:#c0392b; --code:#f3f0e8; --tint:#fbf3ec; }
@media (prefers-color-scheme: dark) { :root { --bg:#1f1e1c; --card:#282725; --ink:#ecebe7; --dim:#9a958a; --line:#3a3834; --soft:#312f2c; --accent:#e08a5a; --ok:#5cc495; --warn:#e2b257; --bad:#ef6f5e; --code:#211f1d; --tint:#33291f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
#app { max-width: 1100px; margin: 0 auto; padding: 18px 20px 60px; }
a { color: var(--accent); }
header.top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
header.top h1 { font-size: 20px; margin: 0; }
header.top .cwd { color: var(--dim); font-size: 13px; }
header.top .back { font-size: 13px; }
header.top .tools { margin-left: auto; display: flex; gap: 2px; align-items: baseline; }
header.top .tools .back { margin-left: 8px; }
.card > h2 { cursor: pointer; user-select: none; }
.chev { flex: none; width: 18px; height: 18px; margin: 0 -4px 0 -4px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.chev::before { content: ""; width: 5px; height: 5px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: translateY(-1px) rotate(45deg); transition: transform .15s; }
.chev:hover, .card > h2:hover .chev { color: var(--ink); }
.card.collapsed .chev::before { transform: translateX(-1px) rotate(-45deg); }
.card.collapsed > :not(h2) { display: none; }
.card.collapsed > h2 { border-bottom: 0; }
.card.unseen > h2 .title::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 7px; border-radius: 50%; background: var(--accent); vertical-align: 2px; }
.state { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; font-weight: 600; white-space: nowrap; }
.state.working { color: var(--ok); } .state.done { color: var(--warn); } .state.blocked { color: var(--accent); } .state.error { color: var(--bad); } .state.idle, .state.ended { color: var(--dim); font-weight: 400; }
.state .msg { font-weight: 400; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
.card > h2 { margin: 0; padding: 6px 8px 6px 12px; min-height: 34px; font-size: 13px; font-weight: 600; letter-spacing: -.005em; background: color-mix(in srgb, var(--soft) 40%, var(--card)); border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; }
.card > h2 .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card > h2 .meta { margin-left: auto; color: var(--dim); font-weight: 400; font-size: 12px; display: flex; gap: 6px; align-items: center; flex: none; padding-right: 4px; }
.card > .bd { padding: 12px 14px; }
.card > .bd.flush { padding: 0; }
.tag { font: 500 10.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 6px; border-radius: 4px; background: var(--soft); color: var(--dim); }
.n { font-size: 11px; font-weight: 500; color: var(--dim); background: var(--soft); border-radius: 9px; padding: 0 6px; }
time[data-at] { font-variant-numeric: tabular-nums; }
.btn { font: 500 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--dim); background: transparent; border: 1px solid transparent; border-radius: 5px; padding: 4px 7px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
.btn:hover { color: var(--ink); background: var(--soft); border-color: var(--line); }
.btn.ok { color: var(--ok); }
.btn.bad { color: #c0392b; }
.status .goal { font-size: 17px; font-weight: 600; line-height: 1.35; letter-spacing: -.01em; }
.eyebrow { display: block; color: var(--dim); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 2px; }
.status .now { margin: 12px 0 16px; padding: 9px 12px; background: var(--tint); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; display: flex; gap: 10px; align-items: baseline; }
.status .now .eyebrow { color: var(--accent); margin: 0; flex: none; }
.pulse { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); align-self: center; }
.pulse.working { background: var(--ok); animation: pulse 2s infinite; }
.pulse.done { background: var(--warn); }
.pulse.blocked { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
.pulse.error { background: var(--bad); }
.pulse.idle { background: transparent; border: 1.5px solid var(--dim); }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); } 70%, 100% { box-shadow: 0 0 0 7px transparent; } }
.status .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 22px; }
.status .col h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; display: flex; gap: 6px; align-items: center; color: var(--ink); }
.status .col ul { list-style: none; margin: 0; padding: 0; }
.status .col li { position: relative; padding: 3px 0 3px 20px; font-size: 13.5px; line-height: 1.4; }
.status .col li::before { position: absolute; left: 0; top: 3px; width: 14px; text-align: center; font-weight: 700; }
.status .col.done li { color: var(--dim); }
.status .col.done li::before { content: "✓"; color: var(--ok); }
.status .col.open li::before { content: "?"; color: var(--warn); }
.status .col.next li::before { content: "→"; color: var(--accent); }
.status .col .none { color: var(--dim); font-size: 13px; padding-left: 20px; }
.card.fresh { animation: fresh 1.6s ease-out; }
@keyframes fresh { from { box-shadow: 0 0 0 2px var(--accent); } to { box-shadow: 0 0 0 2px transparent; } }
.empty { color: var(--dim); font-style: italic; }
.md :first-child { margin-top: 0; } .md :last-child { margin-bottom: 0; }
.md table { border-collapse: collapse; width: 100%; font-size: 13.5px; display: block; overflow-x: auto; }
.md th, .md td { border-bottom: 1px solid var(--soft); padding: 4px 8px; text-align: left; vertical-align: top; }
.md th { border-bottom-color: var(--line); }
.md code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
.md pre { background: var(--code); padding: 10px 12px; border-radius: 8px; overflow-x: auto; margin: 0; font-size: 12.5px; line-height: 1.5; }
.md pre code { background: none; padding: 0; }
.codeblock { position: relative; margin: 10px 0; border: 1px solid var(--line); border-radius: 8px; }
.codeblock:first-child { margin-top: 0; } .codeblock:last-child { margin-bottom: 0; }
.codeblock .lang { position: absolute; top: 6px; left: 10px; font: 500 10px/1 ui-monospace, Menlo, monospace; color: var(--dim); text-transform: lowercase; pointer-events: none; }
.codeblock .lang + pre { padding-top: 24px; }
.codeblock .btn { position: absolute; top: 4px; right: 4px; background: var(--card); border-color: var(--line); opacity: 0; transition: opacity .12s; }
.codeblock:hover .btn, .codeblock .btn:focus-visible, .codeblock .btn.ok { opacity: 1; }
@media (hover: none) { .codeblock .btn { opacity: 1; } }
.md blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--dim); }
.mmd { overflow-x: auto; text-align: center; }
.mmd svg { max-width: 100%; height: auto; }
iframe { display: block; width: 100%; border: 0; background: #fff; }
iframe.plan { height: 82vh; }
img.shot { display: block; max-width: 100%; margin: 0 auto; border-radius: 6px; }
.findings { margin: 0; padding: 0; list-style: none; }
.findings li { display: grid; grid-template-columns: 76px 1fr auto; gap: 0 12px; align-items: start; padding: 7px 14px; border-top: 1px solid var(--soft); font-size: 13.5px; line-height: 1.45; }
.findings li:first-child, .findings li.day + li { border-top: 0; }
.findings li:hover { background: color-mix(in srgb, var(--soft) 45%, transparent); }
.findings li time { color: var(--dim); font-size: 12px; text-align: right; padding-top: 1px; }
.findings li .when { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.tag.auto { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.gallery figure { margin: 0; min-width: 0; }
.gallery img { display: block; width: 100%; height: 150px; object-fit: cover; object-position: top left; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); }
.gallery a:hover img { border-color: var(--accent); }
.gallery figcaption { margin-top: 4px; font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.findings li .btn { opacity: 0; margin: -3px -6px -3px 0; }
.findings li:hover .btn, .findings li .btn:focus-visible, .findings li .btn.ok { opacity: 1; }
@media (hover: none) { .findings li .btn { opacity: 1; } }
.findings li.day { display: block; padding: 10px 14px 4px; border-top: 0; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
.findings li.day:hover { background: none; }
.findings li.more { display: block; padding: 8px 10px 0; border-top: 0; }
.findings li.more .btn { opacity: 1; margin: 0; }
.findings li.more:hover { background: none; }
.sessions .row { display: grid; grid-template-columns: 1fr auto; gap: 0 16px; padding: 10px 14px 11px; border-top: 1px solid var(--soft); color: inherit; text-decoration: none; }
.sessions .row:first-child { border-top: 0; }
.sessions .row:hover { background: color-mix(in srgb, var(--soft) 45%, transparent); }
.sessions .row .main { min-width: 0; }
.sessions .row .line1 { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.sessions .row .name { font-weight: 600; font-size: 14px; white-space: nowrap; }
.sessions .row .cwd { color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessions .row .goal { margin-top: 2px; font-size: 13.5px; line-height: 1.4; }
.sessions .row .goal.none { color: var(--dim); font-style: italic; }
.sessions .row .nowline { margin-top: 3px; color: var(--dim); font-size: 12.5px; line-height: 1.4; display: flex; gap: 7px; align-items: baseline; }
.sessions .row .nowline .eyebrow { margin: 0; flex: none; font-size: 9.5px; }
.sessions .row .chips { margin-top: 6px; display: flex; gap: 5px; flex-wrap: wrap; }
.chip { font-size: 11px; line-height: 1.6; padding: 0 7px; border-radius: 9px; background: var(--soft); color: var(--dim); white-space: nowrap; }
.chip.open { background: color-mix(in srgb, var(--warn) 16%, var(--card)); color: var(--warn); font-weight: 600; }
.chip.next { color: var(--accent); }
.sessions .row .side { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; text-align: right; }
.sessions .row .side time { color: var(--dim); font-size: 12px; }
.sessions .row.ended .name, .sessions .row.ended .goal { color: color-mix(in srgb, var(--ink) 75%, var(--dim)); }
.err { color: #c0392b; font-size: 13px; white-space: pre-wrap; }
`;

const $app = document.getElementById("app");
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};

const tilde = (p) => String(p || "").replace(/^\/Users\/[^/]+/, "~").replace("~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault", "~/Documents/Wiki");

function ago(t) {
  const ms = Date.now() - (typeof t === "number" ? t : Date.parse(t));
  if (!(ms >= 0)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const clock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fullDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

function dayLabel(d) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** A relative time that the ticker below keeps current. */
const agoEl = (iso) => h("time", { "data-at": iso, datetime: iso, title: fullDate(iso) }, ago(iso));
setInterval(() => {
  for (const t of document.querySelectorAll("time[data-at]")) t.textContent = ago(t.dataset.at);
}, 15_000);

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text);
  } catch {}
  // Older path: works when the async API is missing or refuses (no focus).
  const ta = h("textarea", { style: "position:fixed;opacity:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

function copyButton(getText, label = "Copy") {
  const b = h("button", { class: "btn", type: "button", title: "Copy to clipboard" }, label);
  let timer;
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    try {
      await copyText(await getText());
      b.textContent = "Copied";
      b.className = "btn ok";
    } catch {
      b.textContent = "Failed";
      b.className = "btn bad";
    }
    timer = setTimeout(() => ((b.textContent = label), (b.className = "btn")), 1400);
  });
  return b;
}

// ── renderers ────────────────────────────────────────────────────────────────

let mermaidReady;
let mermaidSeq = 0;

function loadMermaid() {
  mermaidReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/assets/vendor/mermaid.js";
    s.onload = () => {
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
      resolve(window.mermaid);
    };
    s.onerror = () => reject(new Error("mermaid failed to load"));
    document.head.append(s);
  });
  return mermaidReady;
}

async function renderMermaid(el, source) {
  // Not "mermaid": mermaid's own startOnLoad scans for that class when its
  // script loads and would empty this box before render() fills it.
  el.classList.add("mmd");
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, source);
    el.innerHTML = svg;
  } catch (e) {
    el.replaceChildren(h("div", { class: "err" }, `mermaid: ${e.message || e}`), h("pre", {}, source));
  }
}

function renderMarkdown(text) {
  const el = h("div", { class: "md" });
  if (!window.marked || !window.DOMPurify) {
    el.append(h("pre", {}, text));
    return el;
  }
  el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true }));
  for (const a of el.querySelectorAll("a[href]")) a.target = "_blank";
  for (const code of el.querySelectorAll("pre > code.language-mermaid")) {
    const box = h("div");
    code.parentElement.replaceWith(box);
    renderMermaid(box, code.textContent);
  }
  for (const pre of el.querySelectorAll("pre")) {
    const code = pre.querySelector("code") || pre;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
    const wrap = h("div", { class: "codeblock" });
    pre.replaceWith(wrap);
    wrap.append(lang ? h("span", { class: "lang" }, lang) : "", pre, copyButton(() => code.textContent.replace(/\n$/, "")));
  }
  return el;
}

function fitFrame(frame) {
  const fit = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      // scrollHeight never drops below the frame's own height, so measure the
      // bottom of the content instead; then the frame can shrink as well as grow.
      const body = doc.body;
      if (!body) return;
      let bottom = 0;
      for (const kid of body.children) bottom = Math.max(bottom, kid.getBoundingClientRect().bottom);
      bottom += parseFloat(doc.defaultView.getComputedStyle(body).marginBottom) || 0;
      frame.style.height = `${Math.min(Math.max(Math.ceil(bottom), 40), 4000)}px`;
    } catch {}
  };
  frame.addEventListener("load", () => {
    fit();
    try {
      new ResizeObserver(fit).observe(frame.contentDocument.body);
    } catch {}
  });
}

async function sectionBody(id, sec) {
  const url = `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(sec.file)}?v=${encodeURIComponent(sec.at || "")}`;
  switch (sec.kind) {
    case "markdown":
      return renderMarkdown(await (await fetch(url)).text());
    case "mermaid": {
      const box = h("div");
      renderMermaid(box, await (await fetch(url)).text());
      return box;
    }
    case "html": {
      const f = h("iframe", { src: url, sandbox: "allow-scripts allow-same-origin allow-popups allow-modals allow-downloads", allow: "clipboard-write", loading: "lazy" });
      fitFrame(f);
      return f;
    }
    case "html-plan":
      return h("iframe", { class: "plan", src: url, sandbox: "allow-scripts allow-same-origin allow-popups allow-modals allow-downloads", allow: "clipboard-write" });
    case "image":
      return h("img", { class: "shot", src: url, alt: sec.title });
    default:
      return h("div", { class: "empty" }, `unknown kind ${sec.kind}`);
  }
}

/** pi's program state (OSC 7501) as the extension mirrored it, or ended. */
function stateOf(s) {
  return s.activity || (s.live ? "done" : "ended");
}

const STATE_LABEL = { working: "working", blocked: "needs input", done: "your turn", error: "failed", idle: "idle" };
const STATE_TIP = {
  working: "The agent is running a turn",
  blocked: "A dialog in pi is waiting for you",
  done: "The turn finished; pi is waiting for your reply",
  error: "The run ended with an error",
  idle: "Started or cancelled; nothing running",
};
/** States where the next move is yours. */
const NEEDS_YOU = new Set(["blocked", "error", "done"]);

function stateBadge(s) {
  const st = stateOf(s);
  if (st === "ended") {
    const at = s.ended || s.meta?.ended;
    return h("span", { class: "state ended" }, at ? `ended ${ago(at)}` : "not running");
  }
  const msg = s.activityMessage || "";
  return h(
    "span",
    { class: `state ${st}`, title: [STATE_TIP[st], msg].filter(Boolean).join(": ") },
    h("span", { class: `pulse ${st}` }),
    STATE_LABEL[st] || st,
    msg && (st === "blocked" || st === "error") ? h("span", { class: "msg" }, `· ${msg}`) : null,
  );
}

const statusBy = (status) => `${status.model || "?"} · ${ago(status.at)}`;

// ── collapsing ───────────────────────────────────────────────────────────────
// Collapsed cards are remembered per session in localStorage. A collapsed
// section's body is not rendered until it is opened, so mermaid and frames
// lay out at their real size.

let collapsed = new Set();
let collapsedKey = "";

function loadCollapsed(sid) {
  collapsedKey = `canvas:collapsed:${sid}`;
  try {
    collapsed = new Set(JSON.parse(localStorage.getItem(collapsedKey) || "[]"));
  } catch {
    collapsed = new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
  } catch {}
}

/** Make a card's header toggle it. onOpen runs the first time its body shows. */
function collapsible(card, key, onOpen) {
  const head = card.querySelector(":scope > h2");
  const chev = h("button", { class: "chev", type: "button" });
  head.prepend(chev);
  card.dataset.key = key;
  let opened = false;
  card.setCollapsed = (shut, remember = true) => {
    card.classList.toggle("collapsed", shut);
    chev.setAttribute("aria-expanded", String(!shut));
    chev.setAttribute("aria-label", shut ? "Expand" : "Collapse");
    chev.title = shut ? "Expand" : "Collapse";
    if (remember) {
      if (shut) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsed();
    }
    if (shut) return;
    card.classList.remove("unseen");
    if (!opened) {
      opened = true;
      onOpen?.();
    }
  };
  head.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input") && !e.target.closest(".chev")) return;
    if (String(getSelection?.() || "")) return; // selecting title text, not toggling
    card.setCollapsed(!card.classList.contains("collapsed"));
  });
  card.setCollapsed(collapsed.has(key), false);
  return card;
}

/** Status and Findings stay on top. Sections follow, newest change first, and
 *  the automatic widgets sit at the bottom so they do not jump up every turn. */
const WIDGETS = ["auto-screenshots", "auto-files"];
function sortSections(list) {
  const w = (s) => WIDGETS.indexOf(s.id);
  return [...list].sort((a, b) => {
    const wa = w(a);
    const wb = w(b);
    if (wa >= 0 || wb >= 0) return (wa < 0 ? -1 : wa) - (wb < 0 ? -1 : wb) || (wa < 0 ? String(b.at).localeCompare(String(a.at)) : 0);
    return String(b.at).localeCompare(String(a.at));
  });
}

function statusCard(status, state) {
  const title = h("h2", {}, h("span", { class: "title" }, "Status"));
  const card = h("section", { class: "card" }, title);
  const bd = h("div", { class: "bd status" });
  card.append(bd);
  if (!status) {
    bd.append(h("div", { class: "empty" }, "No status yet. It appears after the next turn with tool calls."));
    return collapsible(card, "_status");
  }
  title.append(h("span", { class: "meta" }, h("span", { class: "by" }, statusBy(status))));
  bd.append(h("div", { class: "goal" }, h("span", { class: "eyebrow" }, "Goal"), status.goal || "—"));
  bd.append(h("div", { class: "now" }, h("span", { class: `pulse ${state}` }), h("span", { class: "eyebrow" }, "Now"), h("span", {}, status.now || "—")));
  const col = (kind, label, items) =>
    h(
      "div",
      { class: `col ${kind}` },
      h("h3", {}, label, h("span", { class: "n" }, String(items?.length || 0))),
      items?.length ? h("ul", {}, items.map((i) => h("li", {}, i))) : h("div", { class: "none" }, "—"),
    );
  bd.append(h("div", { class: "cols" }, col("next", "Next", status.next), col("open", "Open", status.open), col("done", "Done", status.done)));
  return collapsible(card, "_status");
}

const FINDINGS_SHOWN = 8;

function findingsCard(findings, showAll = false) {
  if (!findings?.length) return null;
  const list = h("ul", { class: "findings" });
  const card = h(
    "section",
    { class: "card", id: "findings" },
    h("h2", {}, h("span", { class: "title" }, "Findings"), h("span", { class: "n" }, String(findings.length)), h("span", { class: "meta" }, copyButton(() => findings.map((f) => `- ${f.text}`).join("\n"), "Copy all"))),
    h("div", { class: "bd flush" }, list),
  );
  const hidden = showAll ? 0 : Math.max(0, findings.length - FINDINGS_SHOWN);
  if (hidden) {
    const more = h("button", { class: "btn", type: "button" }, `Show ${hidden} earlier`);
    more.addEventListener("click", () => card.replaceWith(findingsCard(findings, true)));
    list.append(h("li", { class: "more" }, more));
  }
  let lastDay = "";
  for (const f of findings.slice(hidden)) {
    const d = new Date(f.at);
    const valid = !Number.isNaN(d.getTime());
    const day = valid ? dayLabel(d) : "";
    if (day && day !== lastDay) list.append(h("li", { class: "day" }, day));
    lastDay = day || lastDay;
    list.append(
      h(
        "li",
        {},
        h(
          "span",
          { class: "when" },
          h("time", { datetime: f.at, title: fullDate(f.at) }, valid ? clock(d) : f.at || ""),
          f.by === "auto" ? h("span", { class: "tag auto", title: "Written by the status model" }, "auto") : null,
        ),
        renderMarkdown(f.text),
        copyButton(() => f.text),
      ),
    );
  }
  return collapsible(card, "_findings");
}

const rawUrl = (id, sec, bust = true) =>
  `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(sec.file)}${bust ? `?v=${encodeURIComponent(sec.at || "")}` : ""}`;

function sectionCard(id, sec) {
  const meta = h(
    "span",
    { class: "meta" },
    sec.by === "auto" ? h("span", { class: "tag auto", title: "Kept up to date automatically" }, "auto") : null,
    h("span", { class: "tag" }, sec.kind),
    agoEl(sec.at),
  );
  if (sec.kind === "markdown" || sec.kind === "mermaid") meta.append(copyButton(async () => (await fetch(rawUrl(id, sec))).text(), "Copy source"));
  meta.append(h("a", { class: "btn", href: rawUrl(id, sec, false), target: "_blank", title: "Open in a new tab" }, "↗"));
  const flush = sec.kind === "html" || sec.kind === "html-plan";
  const bd = h("div", { class: `bd${flush ? " flush" : ""}` });
  const el = h("section", { class: "card", id: `sec-${sec.id}` }, h("h2", {}, h("span", { class: "title", title: sec.title || sec.id }, sec.title || sec.id), meta), bd);
  return collapsible(el, sec.id, () =>
    sectionBody(id, sec).then(
      (body) => bd.replaceChildren(body),
      (e) => bd.replaceChildren(h("div", { class: "err" }, String(e))),
    ),
  );
}

// ── session view ─────────────────────────────────────────────────────────────

async function sessionView(id) {
  const header = h("header", { class: "top" });
  const statusSlot = h("div");
  const sectionsSlot = h("div");
  const findingsSlot = h("div");
  $app.replaceChildren(header, statusSlot, findingsSlot, sectionsSlot);
  loadCollapsed(id);
  const cards = new Map(); // section id → { at, el }
  let lastStatusAt;
  let lastState;
  let lastFindings = -1;

  async function refresh() {
    let state;
    try {
      state = await (await fetch(`/api/s/${encodeURIComponent(id)}`)).json();
    } catch {
      return;
    }
    const name = state.meta.name || id.slice(0, 8);
    document.title = `${name} · canvas`;
    header.replaceChildren(
      h("h1", {}, name),
      h("span", { class: "cwd" }, tilde(state.meta.cwd)),
      stateBadge(state),
      h(
        "span",
        { class: "tools" },
        h("button", { class: "btn", type: "button", onclick: () => setAll(true) }, "Collapse all"),
        h("button", { class: "btn", type: "button", onclick: () => setAll(false) }, "Expand all"),
        h("a", { class: "back", href: "/" }, "All sessions"),
      ),
    );
    if (state.status?.at !== lastStatusAt || stateOf(state) !== lastState || !statusSlot.firstChild) {
      const changed = lastStatusAt !== undefined && state.status?.at !== lastStatusAt;
      lastStatusAt = state.status?.at;
      lastState = stateOf(state);
      const card = statusCard(state.status, lastState);
      if (changed) card.classList.add("fresh");
      if (changed && card.classList.contains("collapsed")) card.classList.add("unseen");
      statusSlot.replaceChildren(card);
    } else {
      // Keep the "12s ago" honest without a rebuild.
      const by = statusSlot.querySelector(".by");
      if (by && state.status) by.textContent = statusBy(state.status);
    }

    const sections = sortSections(state.sections);
    const keep = new Set(sections.map((s) => s.id));
    for (const [sid, c] of cards) if (!keep.has(sid)) (c.el.remove(), cards.delete(sid));
    sectionsSlot.querySelector(":scope > p.empty")?.remove();
    sections.forEach((sec, i) => {
      let c = cards.get(sec.id);
      if (!c || c.at !== sec.at) {
        const el = sectionCard(id, sec);
        if (c) {
          el.classList.add("fresh");
          if (el.classList.contains("collapsed")) el.classList.add("unseen");
          c.el.replaceWith(el);
        }
        c = { at: sec.at, el };
        cards.set(sec.id, c);
      }
      // Move a card only when its place changed: moving a frame reloads it.
      const here = sectionsSlot.children[i];
      if (here !== c.el) sectionsSlot.insertBefore(c.el, here || null);
    });
    if (!sections.length) sectionsSlot.append(h("p", { class: "empty" }, "No sections yet."));

    if (state.findings.length !== lastFindings) {
      const grew = lastFindings >= 0 && state.findings.length > lastFindings;
      lastFindings = state.findings.length;
      const card = findingsCard(state.findings);
      if (card && grew) {
        card.classList.add("fresh");
        if (card.classList.contains("collapsed")) card.classList.add("unseen");
      }
      findingsSlot.replaceChildren(card || "");
    }
  }

  function setAll(shut) {
    for (const card of $app.querySelectorAll(".card[data-key]")) card.setCollapsed?.(shut);
  }

  await refresh();
  const es = new EventSource(`/api/s/${encodeURIComponent(id)}/events`);
  es.addEventListener("changed", refresh);
  setInterval(refresh, 30_000);
}

// ── index view ───────────────────────────────────────────────────────────────

async function indexView() {
  document.title = "Canvas";
  const groups = h("div");
  const header = h("header", { class: "top" }, h("h1", {}, "Canvas"), h("span", { class: "cwd" }, ""));
  $app.replaceChildren(header, groups);

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function row(s) {
    const st = stateOf(s);
    const endedAt = s.ended || (s.live ? undefined : new Date(s.updated).toISOString());
    const updatedIso = new Date(s.updated).toISOString();
    const chips = [
      s.open ? h("span", { class: "chip open", title: "Open questions in the status" }, `${s.open} open`) : null,
      s.next ? h("span", { class: "chip next" }, `${s.next} next`) : null,
      s.done ? h("span", { class: "chip" }, `${s.done} done`) : null,
      s.sections ? h("span", { class: "chip" }, plural(s.sections, "section")) : null,
      s.findings ? h("span", { class: "chip" }, plural(s.findings, "finding")) : null,
    ].filter(Boolean);
    // Live rows say how long ago; ended rows sit under a day heading, so the
    // clock time is enough.
    const when = st === "ended" ? h("time", { datetime: endedAt, title: fullDate(endedAt) }, clock(new Date(endedAt))) : agoEl(updatedIso);
    return h(
      "a",
      { class: `row ${st}`, href: `/s/${encodeURIComponent(s.id)}` },
      h(
        "div",
        { class: "main" },
        h("div", { class: "line1" }, h("span", { class: "name" }, s.name || s.id.slice(0, 8)), h("span", { class: "cwd" }, tilde(s.cwd))),
        h("div", { class: `goal${s.goal ? "" : " none"}` }, s.goal || "No status yet"),
        s.now && st !== "ended" ? h("div", { class: "nowline" }, h("span", { class: "eyebrow" }, "Now"), h("span", {}, s.now)) : null,
        s.now && st === "ended" ? h("div", { class: "nowline" }, h("span", { class: "eyebrow" }, "Last"), h("span", {}, s.now)) : null,
        chips.length ? h("div", { class: "chips" }, chips) : null,
      ),
      h("div", { class: "side" }, st === "ended" ? "" : stateBadge(s), when),
    );
  }

  function group(title, sessions, extra) {
    return h(
      "section",
      { class: "card sessions" },
      h("h2", {}, h("span", { class: "title" }, title), h("span", { class: "n" }, String(sessions.length)), extra ? h("span", { class: "meta" }, extra) : null),
      h("div", { class: "bd flush" }, sessions.map(row)),
    );
  }

  async function refresh() {
    let sessions;
    try {
      sessions = await (await fetch("/api/sessions")).json();
    } catch {
      return;
    }
    const active = sessions.filter((s) => s.live);
    const waiting = active.filter((s) => NEEDS_YOU.has(stateOf(s))).length;
    header.querySelector(".cwd").textContent = [plural(sessions.length, "session"), waiting ? `${waiting} waiting on you` : ""].filter(Boolean).join(" · ");
    if (!sessions.length) return groups.replaceChildren(h("section", { class: "card" }, h("div", { class: "bd empty" }, "No sessions yet. A session gets a page on its first status or section.")));
    // The ones that need you first, most urgent first.
    const rank = { blocked: 0, error: 1, done: 2, working: 3, idle: 4 };
    active.sort((a, b) => (rank[stateOf(a)] ?? 5) - (rank[stateOf(b)] ?? 5) || b.updated - a.updated);
    const out = [];
    if (active.length) out.push(group("Active", active));
    const byDay = new Map();
    for (const s of sessions.filter((x) => !x.live).sort((a, b) => Date.parse(b.ended || 0) - Date.parse(a.ended || 0) || b.updated - a.updated)) {
      const d = new Date(s.ended || s.updated);
      const key = dayLabel(d);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(s);
    }
    for (const [day, list] of byDay) out.push(group(day, list));
    groups.replaceChildren(...out);
  }

  await refresh();
  const es = new EventSource("/api/events");
  es.addEventListener("changed", refresh);
}

const m = location.pathname.match(/^\/s\/([^/]+)\/?$/);
if (m) sessionView(decodeURIComponent(m[1]));
else indexView();
