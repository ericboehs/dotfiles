// Session canvas page. Served by daemon.mjs at / (index) and /s/<id>.
// Re-fetches state on each server-sent "changed" event and re-renders only the
// sections whose timestamp moved, so iframes and scroll position survive.

const CSS = `
:root { color-scheme: light dark; --bg:#f7f5f0; --card:#fff; --ink:#1c1b19; --dim:#8a8578; --line:#e6e1d6; --soft:#f0ece3; --accent:#b4541f; --ok:#1f7a52; --code:#f3f0e8; }
@media (prefers-color-scheme: dark) { :root { --bg:#1f1e1c; --card:#282725; --ink:#ecebe7; --dim:#9a958a; --line:#3a3834; --soft:#312f2c; --accent:#e08a5a; --ok:#5cc495; --code:#211f1d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
#app { max-width: 1100px; margin: 0 auto; padding: 18px 20px 60px; }
a { color: var(--accent); }
header.top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
header.top h1 { font-size: 20px; margin: 0; }
header.top .cwd { color: var(--dim); font-size: 13px; }
header.top .back { margin-left: auto; font-size: 13px; }
.dot { font-size: 12px; font-weight: 600; } .dot.on { color: var(--ok); } .dot.off { color: var(--dim); font-weight: 400; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
.status { display: grid; grid-template-columns: 64px 1fr; gap: 4px 12px; }
.status .k { color: var(--dim); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; padding-top: 2px; }
.status ul { margin: 0; padding-left: 18px; }
.status .by { grid-column: 1 / -1; text-align: right; color: var(--dim); font-size: 11.5px; }
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
.sessions .row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 10px 14px; border-bottom: 1px solid var(--soft); color: inherit; text-decoration: none; }
.sessions .row:hover { background: var(--soft); }
.sessions .row:last-child { border-bottom: 0; }
.sessions .row small { color: var(--dim); }
.sessions .now { grid-column: 1 / -1; color: var(--dim); font-size: 13px; }
.findings li { display: grid; grid-template-columns: 76px 1fr auto; gap: 0 12px; align-items: start; padding: 7px 14px; border-top: 1px solid var(--soft); font-size: 13.5px; line-height: 1.45; }
.findings li:first-child, .findings li.day + li { border-top: 0; }
.findings li:hover { background: color-mix(in srgb, var(--soft) 45%, transparent); }
.findings li time { color: var(--dim); font-size: 12px; text-align: right; padding-top: 1px; }
.findings li .btn { opacity: 0; margin: -3px -6px -3px 0; }
.findings li:hover .btn, .findings li .btn:focus-visible, .findings li .btn.ok { opacity: 1; }
@media (hover: none) { .findings li .btn { opacity: 1; } }
.findings li.day { display: block; padding: 10px 14px 4px; border-top: 0; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
.findings li.day:hover { background: none; }
.findings li.more { display: block; padding: 8px 10px 0; border-top: 0; }
.findings li.more .btn { opacity: 1; margin: 0; }
.findings li.more:hover { background: none; }
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

function statusCard(status) {
  const card = h("section", { class: "card" }, h("h2", {}, "Status"));
  const bd = h("div", { class: "bd" });
  card.append(bd);
  if (!status) {
    bd.append(h("div", { class: "empty" }, "No status yet. It appears after the next turn with tool calls."));
    return card;
  }
  const grid = h("div", { class: "status" });
  const list = (items) => (items?.length ? h("ul", {}, items.map((i) => h("li", {}, i))) : h("span", { class: "empty" }, "—"));
  grid.append(h("span", { class: "k" }, "Goal"), h("span", {}, status.goal || "—"));
  grid.append(h("span", { class: "k" }, "Now"), h("span", {}, status.now || "—"));
  grid.append(h("span", { class: "k" }, "Done"), list(status.done));
  grid.append(h("span", { class: "k" }, "Open"), list(status.open));
  grid.append(h("span", { class: "k" }, "Next"), list(status.next));
  grid.append(h("span", { class: "by" }, `status · ${status.model || "?"} · ${ago(status.at)}`));
  bd.append(grid);
  return card;
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
      h("li", {}, h("time", { datetime: f.at, title: fullDate(f.at) }, valid ? clock(d) : f.at || ""), renderMarkdown(f.text), copyButton(() => f.text)),
    );
  }
  return card;
}

const rawUrl = (id, sec, bust = true) =>
  `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(sec.file)}${bust ? `?v=${encodeURIComponent(sec.at || "")}` : ""}`;

function sectionCard(id, sec) {
  const meta = h("span", { class: "meta" }, h("span", { class: "tag" }, sec.kind), agoEl(sec.at));
  if (sec.kind === "markdown" || sec.kind === "mermaid") meta.append(copyButton(async () => (await fetch(rawUrl(id, sec))).text(), "Copy source"));
  meta.append(h("a", { class: "btn", href: rawUrl(id, sec, false), target: "_blank", title: "Open in a new tab" }, "↗"));
  const flush = sec.kind === "html" || sec.kind === "html-plan";
  const bd = h("div", { class: `bd${flush ? " flush" : ""}` });
  const el = h("section", { class: "card", id: `sec-${sec.id}` }, h("h2", {}, h("span", { class: "title", title: sec.title || sec.id }, sec.title || sec.id), meta), bd);
  sectionBody(id, sec).then(
    (body) => bd.replaceChildren(body),
    (e) => bd.replaceChildren(h("div", { class: "err" }, String(e))),
  );
  return el;
}

// ── session view ─────────────────────────────────────────────────────────────

async function sessionView(id) {
  const header = h("header", { class: "top" });
  const statusSlot = h("div");
  const sectionsSlot = h("div");
  const findingsSlot = h("div");
  $app.replaceChildren(header, statusSlot, findingsSlot, sectionsSlot);
  const cards = new Map(); // section id → { at, el }
  let lastStatusAt;
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
      h("span", { class: `dot ${state.live ? "on" : "off"}` }, state.live ? "● live" : state.meta.ended ? `ended ${ago(state.meta.ended)}` : "not running"),
      h("a", { class: "back", href: "/" }, "All sessions"),
    );
    if (state.status?.at !== lastStatusAt || !statusSlot.firstChild) {
      lastStatusAt = state.status?.at;
      statusSlot.replaceChildren(statusCard(state.status));
    } else {
      // Keep the "12s ago" honest without a rebuild.
      const by = statusSlot.querySelector(".by");
      if (by && state.status) by.textContent = `status · ${state.status.model || "?"} · ${ago(state.status.at)}`;
    }

    const sections = [...state.sections].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.at).localeCompare(String(b.at)));
    const keep = new Set(sections.map((s) => s.id));
    for (const [sid, c] of cards) if (!keep.has(sid)) (c.el.remove(), cards.delete(sid));
    for (const sec of sections) {
      let c = cards.get(sec.id);
      if (!c || c.at !== sec.at) {
        const el = sectionCard(id, sec);
        if (c) c.el.replaceWith(el);
        c = { at: sec.at, el };
        cards.set(sec.id, c);
      }
      sectionsSlot.append(c.el); // re-append keeps order without re-creating
    }
    if (!sections.length && !sectionsSlot.firstChild) sectionsSlot.append(h("p", { class: "empty" }, "No sections yet."));
    else sectionsSlot.querySelector(":scope > p.empty")?.remove();

    if (state.findings.length !== lastFindings) {
      lastFindings = state.findings.length;
      findingsSlot.replaceChildren(findingsCard(state.findings) || "");
    }
  }

  await refresh();
  const es = new EventSource(`/api/s/${encodeURIComponent(id)}/events`);
  es.addEventListener("changed", refresh);
  setInterval(refresh, 30_000);
}

// ── index view ───────────────────────────────────────────────────────────────

async function indexView() {
  document.title = "Canvas";
  const list = h("section", { class: "card sessions" });
  const header = h("header", { class: "top" }, h("h1", {}, "Canvas"), h("span", { class: "cwd" }, ""));
  $app.replaceChildren(header, list);

  async function refresh() {
    let sessions;
    try {
      sessions = await (await fetch("/api/sessions")).json();
    } catch {
      return;
    }
    header.querySelector(".cwd").textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    if (!sessions.length) return list.replaceChildren(h("div", { class: "bd empty" }, "No sessions yet."));
    list.replaceChildren(
      ...sessions.map((s) =>
        h(
          "a",
          { class: "row", href: `/s/${encodeURIComponent(s.id)}` },
          h("b", {}, s.name || s.id.slice(0, 8)),
          h("span", { class: `dot ${s.live ? "on" : "off"}` }, s.live ? "● live" : `ended ${ago(s.ended || s.updated)}`),
          h("small", {}, [tilde(s.cwd), s.sections ? `${s.sections} section${s.sections === 1 ? "" : "s"}` : "", s.findings ? `${s.findings} finding${s.findings === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")),
          h("small", {}, ago(s.updated)),
          s.now || s.goal ? h("span", { class: "now" }, s.now || s.goal) : null,
        ),
      ),
    );
  }

  await refresh();
  const es = new EventSource("/api/events");
  es.addEventListener("changed", refresh);
}

const m = location.pathname.match(/^\/s\/([^/]+)\/?$/);
if (m) sessionView(decodeURIComponent(m[1]));
else indexView();
