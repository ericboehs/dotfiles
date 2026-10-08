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
.card > h2 { margin: 0; padding: 8px 14px; font-size: 14px; border-bottom: 1px solid var(--soft); display: flex; gap: 8px; align-items: baseline; }
.card > h2 .meta { margin-left: auto; color: var(--dim); font-weight: 400; font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
.card > .bd { padding: 10px 14px; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 9px; background: var(--soft); color: var(--dim); }
.status { display: grid; grid-template-columns: 64px 1fr; gap: 4px 12px; }
.status .k { color: var(--dim); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; padding-top: 2px; }
.status ul { margin: 0; padding-left: 18px; }
.status .by { grid-column: 1 / -1; text-align: right; color: var(--dim); font-size: 11.5px; }
.empty { color: var(--dim); font-style: italic; }
.md :first-child { margin-top: 0; } .md :last-child { margin-bottom: 0; }
.md table { border-collapse: collapse; width: 100%; font-size: 13.5px; display: block; overflow-x: auto; }
.md th, .md td { border-bottom: 1px solid var(--soft); padding: 4px 8px; text-align: left; vertical-align: top; }
.md th { border-bottom-color: var(--line); }
.md code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
.md pre { background: var(--code); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--dim); }
.mmd { overflow-x: auto; text-align: center; }
.mmd svg { max-width: 100%; height: auto; }
iframe { display: block; width: 100%; border: 0; background: #fff; }
iframe.plan { height: 82vh; }
img.shot { display: block; max-width: 100%; margin: 0 auto; border-radius: 6px; }
.findings { margin: 0; padding: 0; list-style: none; }
.findings li { padding: 6px 0; border-bottom: 1px solid var(--soft); display: grid; grid-template-columns: 92px 1fr; gap: 10px; }
.findings li:last-child { border-bottom: 0; }
.findings time { color: var(--dim); font-size: 12px; padding-top: 2px; }
.sessions .row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 10px 14px; border-bottom: 1px solid var(--soft); color: inherit; text-decoration: none; }
.sessions .row:hover { background: var(--soft); }
.sessions .row:last-child { border-bottom: 0; }
.sessions .row small { color: var(--dim); }
.sessions .now { grid-column: 1 / -1; color: var(--dim); font-size: 13px; }
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

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
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

function findingsCard(findings) {
  if (!findings?.length) return null;
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Findings", h("span", { class: "meta" }, String(findings.length))),
    h("div", { class: "bd" }, h("ul", { class: "findings" }, findings.map((f) => h("li", {}, h("time", {}, shortTime(f.at)), renderMarkdown(f.text))))),
  );
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
        const open = h("a", { href: `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(sec.file)}`, target: "_blank" }, "open ↗");
        const el = h(
          "section",
          { class: "card", id: `sec-${sec.id}` },
          h("h2", {}, sec.title || sec.id, h("span", { class: "meta" }, h("span", { class: "tag" }, sec.kind), ago(sec.at), open)),
          h("div", { class: "bd" }),
        );
        sectionBody(id, sec).then((body) => el.querySelector(".bd").replaceChildren(body), (e) => el.querySelector(".bd").replaceChildren(h("div", { class: "err" }, String(e))));
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
