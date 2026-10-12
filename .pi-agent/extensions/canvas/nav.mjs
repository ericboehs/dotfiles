// Picker and banner logic: which other sessions are waiting on you, how the
// Cmd-K list is ordered, and the fuzzy match. Shared by the page (as
// /assets/nav.mjs) and the tests, so nothing here touches the DOM.

/** States where a session is waiting on you. */
export const WAITING_STATES = new Set(["blocked", "done", "error"]);
const URGENCY = { blocked: 0, error: 1, done: 2 };

const at = (s) => Date.parse(s?.activityAt || "") || Number(s?.updated) || 0;

/**
 * Other live sessions that are waiting on you and changed state since you
 * last had their page in view. `seen` maps session id → epoch ms.
 * Most urgent first (blocked, error, done), then newest.
 */
export function waitingSessions(list, seen, currentId) {
  return (list || [])
    .filter((s) => s && s.live && s.id !== currentId && WAITING_STATES.has(s.activity) && at(s) > (Number(seen?.[s.id]) || 0))
    .sort((a, b) => URGENCY[a.activity] - URGENCY[b.activity] || at(b) - at(a));
}

/**
 * The seen map to store. On the first run (no map yet) every session counts
 * as seen, so only changes from now on raise a chip. Entries for sessions
 * that are gone are dropped.
 */
export function nextSeen(prev, list, now = Date.now()) {
  const ids = new Set((list || []).map((s) => s.id));
  if (!prev) return Object.fromEntries([...ids].map((id) => [id, now]));
  return Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
}

/** Waiting first, then the rest of the live ones, then ended (newest first). */
export function orderSessions(list, waiting, currentId) {
  const first = new Set((waiting || []).map((s) => s.id));
  const rest = (list || []).filter((s) => s && s.id !== currentId && !first.has(s.id));
  const live = rest.filter((s) => s.live).sort((a, b) => at(b) - at(a));
  const ended = rest.filter((s) => !s.live).sort((a, b) => (Date.parse(b.ended || "") || b.updated || 0) - (Date.parse(a.ended || "") || a.updated || 0));
  return [...(waiting || []), ...live, ...ended];
}

/**
 * Fuzzy score of query against text: every query character must appear in
 * order. Higher is better; -1 is no match. Rewards matches at word starts
 * and runs of adjacent characters, and slightly prefers shorter texts.
 */
export function fuzzyScore(query, text) {
  const q = String(query || "").toLowerCase().replace(/\s+/g, "");
  const t = String(text || "").toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    const start = i === 0 || /[\s\-_/.·:]/.test(t[i - 1]);
    score += 1 + (start ? 3 : 0) + (i === prev + 1 ? 2 : 0);
    prev = i;
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

/** Items that match, best first; ties keep their given order. */
export function rankItems(items, query, key = (x) => x.label) {
  if (!String(query || "").trim()) return items.slice();
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, key(item)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

// ── vim keys ────────────────────────────────────────────────────────────────────────
// One table drives both the key handling and the ? overlay, so they can't
// drift. Ctrl-d / Ctrl-u are handled with the modifiers, not here.

export const VIM_KEYS = [
  { group: "Move", keys: "j", action: "next", help: "next section" },
  { group: "Move", keys: "k", action: "prev", help: "previous section" },
  { group: "Move", keys: "h", action: "toMain", help: "left, back to the main column (from a Contents entry: open that section)" },
  { group: "Move", keys: "l", action: "toSide", help: "right, over to the side panel, on this section's Contents entry (j / k step through it)" },
  { group: "Move", keys: "gg", action: "top", help: "top of the page" },
  { group: "Move", keys: "G", action: "bottom", help: "bottom of the page" },
  { group: "Move", keys: "d", action: "halfDown", help: "half a page down (or Ctrl-d)" },
  { group: "Move", keys: "u", action: "halfUp", help: "half a page up (or Ctrl-u)" },
  { group: "Move", keys: "n", action: "nextChanged", help: "next section changed while folded (the dot) or in the last turn" },
  { group: "Move", keys: "N", action: "prevChanged", help: "previous changed section" },
  { group: "Fold", keys: "o", action: "toggle", help: "open or fold this section (or Enter, za)" },
  { group: "Fold", keys: "Enter", action: "toggle", help: "" },
  { group: "Fold", keys: "za", action: "toggle", help: "" },
  { group: "Fold", keys: "zo", action: "open", help: "open this section" },
  { group: "Fold", keys: "zc", action: "close", help: "fold this section" },
  { group: "Fold", keys: "zR", action: "openAll", help: "open every section" },
  { group: "Fold", keys: "zM", action: "foldAll", help: "fold every section" },
  { group: "Yank", keys: "yy", action: "yankFile", help: "copy this section's file (Clippy), to paste as a file" },
  { group: "Yank", keys: "yc", action: "yankSource", help: "copy this section's source as text" },
  { group: "Other", keys: "p", action: "pin", help: "pin this section to the top of the page, or unpin it" },
  { group: "Other", keys: "K", action: "moveUp", help: "move this side panel card up (or drag its header)" },
  { group: "Other", keys: "J", action: "moveDown", help: "move this side panel card down" },
  { group: "Other", keys: "?", action: "help", help: "this list" },
];

/**
 * Where a typed sequence stands: { action } when it names one, { pending }
 * when it is the start of one (wait for the next key), or {} when it is
 * neither (drop it).
 */
export function matchKeys(seq) {
  const hit = VIM_KEYS.find((k) => k.keys === seq);
  if (hit) return { action: hit.action };
  if (seq && VIM_KEYS.some((k) => k.keys.startsWith(seq))) return { pending: true };
  return {};
}

// ── kanban ─────────────────────────────────────────────────────────────────────

/**
 * `code`, **bold** and [text](http(s) url) in a one-line string, as tokens
 * for the page to build as DOM; everything else is plain text, so nothing
 * here can become markup.
 */
export function inlineTokens(text) {
  const s = String(text ?? "");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] != null) out.push({ t: "code", v: m[1] });
    else if (m[2] != null) out.push({ t: "b", v: m[2] });
    else out.push({ t: "a", v: m[3], href: m[4] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

/**
 * A todo-tool owner ("pi-" + the last four of a session id) as a session:
 * { session, state, me }, or null for anything else (a person's name) or a
 * suffix two live sessions share. A live one wins; else the newest ended.
 */
export function ownerSession(owner, sessions, currentId) {
  const m = /^pi-([A-Za-z0-9]{4})$/.exec(owner || "");
  if (!m) return null;
  const hits = (sessions || []).filter((s) => String(s.id).endsWith(m[1]));
  const live = hits.filter((s) => s.live);
  const when = (s) => Date.parse(s.ended || "") || Number(s.updated) || 0;
  const s = live.length ? (live.length === 1 ? live[0] : null) : hits.sort((a, b) => when(b) - when(a))[0];
  if (!s) return null;
  return { session: s, state: s.live ? s.activity || "done" : "ended", me: s.id === currentId };
}

const cardKey = (k) => (k.id ? `id:${k.id}` : `t:${k.title}`);

/** Where each card sits: { cardKey: column label }, or null for a key on more than one card. */
export function boardSnapshot(columns) {
  const m = {};
  for (const c of columns || [])
    for (const k of c.cards || []) {
      const key = cardKey(k);
      m[key] = key in m ? null : c.label;
    }
  return m;
}

/**
 * Cards that are new or in another column since the snapshot `prev`:
 * { cardKey: "new" | the column it moved to }. Nothing on a first look, and
 * nothing for a key two cards share (which one moved is a guess).
 */
export function boardMoves(prev, columns) {
  if (!prev) return {};
  const now = boardSnapshot(columns);
  const out = {};
  for (const [key, label] of Object.entries(now)) {
    if (label === null || prev[key] === null) continue;
    if (!(key in prev)) out[key] = "new";
    else if (prev[key] !== label) out[key] = label;
  }
  return out;
}
export { cardKey };

/**
 * Moved marks for one board. `saved` is what this browser stored last time
 * ({ snap, moves, at }, at 0 while no one has seen the marks). Marks stay for
 * `keepMs` after they were first seen, so a redraw doesn't wipe them, and
 * marks no one has seen yet carry over into the next change. Returns the
 * marks to show and the entry to store (null: keep the old one).
 */
export function boardMarks(saved, columns, { now = Date.now(), keepMs = 15 * 60e3, visible = true } = {}) {
  const snap = boardSnapshot(columns);
  const keys = Object.keys(snap);
  const same = !!saved?.snap && keys.length === Object.keys(saved.snap).length && keys.every((k) => saved.snap[k] === snap[k]);
  if (same) {
    if (!saved.at) return { moves: saved.moves || {}, save: visible ? { ...saved, at: now } : null };
    return { moves: now - saved.at < keepMs ? saved.moves || {} : {}, save: null };
  }
  const carried = {};
  if (saved && !saved.at) for (const [k, v] of Object.entries(saved.moves || {})) if (k in snap) carried[k] = v;
  const moves = { ...carried, ...boardMoves(saved?.snap, columns) };
  return { moves, save: { snap, moves, at: visible ? now : 0 } };
}

// ── pins ─────────────────────────────────────────────────────────────────────────────

/**
 * A pipeline label in up to two lines of max px (measure gives a string's
 * width): whole words first, characters when one word is too long; the second
 * line ends in … when text is left over.
 */
export function wrapLabel(text, max, measure) {
  const s = String(text ?? "");
  if (!(max < Infinity) || measure(s) <= max) return [s];
  const fit = (t, ell) => {
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(t.slice(0, mid).trimEnd() + (ell ? "…" : "")) <= max) lo = mid;
      else hi = mid - 1;
    }
    return t.slice(0, lo);
  };
  let first = "";
  for (const w of s.split(" ")) {
    const next = first ? `${first} ${w}` : w;
    if (measure(next) > max) break;
    first = next;
  }
  if (!first) first = fit(s, false) || s[0];
  const rest = s.slice(first.length).trim();
  if (!rest) return [first];
  return [first, measure(rest) <= max ? rest : `${fit(rest, true).trimEnd()}…`];
}

/**
 * Rows for a pipeline too wide for its card. sizes: per stage, {cols, col (px
 * per column), split (one lane, no loop: may break between its steps)}; inner:
 * the row width; gap: px between stages. Rows break between stages; a stage
 * wider than a row on its own starts a row and, when it may split, spreads over
 * rows in even chunks (the last chunk shares its row with what follows).
 * Returns rows of {k: stage, a, b: its columns a..b-1}.
 */
export function pipeRows(sizes, inner, gap) {
  const rows = [];
  let row = [];
  let used = 0;
  const width = (u) => (u.b - u.a) * sizes[u.k].col;
  const flush = () => {
    if (row.length) rows.push(row);
    row = [];
    used = 0;
  };
  const put = (u) => {
    used += (row.length ? gap : 0) + width(u);
    row.push(u);
  };
  sizes.forEach((s, k) => {
    const u = { k, a: 0, b: s.cols };
    if (used + (row.length ? gap : 0) + width(u) <= inner) return put(u);
    flush();
    if (width(u) <= inner || !s.split) return put(u);
    const per = Math.max(1, Math.floor(inner / s.col));
    const size = Math.ceil(s.cols / Math.ceil(s.cols / per));
    for (let a = 0; a < s.cols; a += size) {
      if (a) flush();
      put({ k, a, b: Math.min(s.cols, a + size) });
    }
  });
  flush();
  return rows;
}

/** Text as a markdown blockquote (⌥-click on a copy button): "> " on every line, a bare ">" on blank ones. */
export function asQuote(text) {
  return String(text ?? "")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

/**
 * Markdown as Slack markup (⇧-click on a copy button), for pasting into the
 * composer: **b** → *b*, *i* or _i_ → _i_, ~~s~~ → ~s~, a heading → a *bold*
 * line, - / * / + items → • (task boxes → ☐ / ☑), --- → a rule, a
 * table → an aligned code block, <br> → a newline, an image → its link.
 * Links ([t](u), which Slack takes), code spans, fenced code (its language
 * dropped), quotes and numbered items stay as they are.
 */
export function slackText(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = l.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence) {
      // Through the closing fence, untouched but the language.
      out.push(`${fence[1]}\`\`\``);
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[2]); i++) out.push(lines[i]);
      out.push(`${fence[1]}\`\`\``);
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const rows = [];
      for (; i < lines.length && isRow(lines[i]); i++) if (!isSep(lines[i])) rows.push(tableCells(lines[i]).map(plainInline));
      i--;
      out.push("```", ...alignRows(rows), "```");
      continue;
    }
    out.push(slackLine(l));
  }
  return out.join("\n");
}

function tableCells(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function alignRows(rows) {
  const n = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: n }, (_, k) => Math.max(...rows.map((r) => [...(r[k] ?? "")].length)));
  const line = (r) => r.map((c, k) => (k === n - 1 ? c : c + " ".repeat(w[k] - [...c].length))).join("  ").trimEnd();
  const [head, ...body] = rows;
  return [line(head), w.map((x) => "-".repeat(x)).join("  "), ...body.map((r) => line(Array.from({ length: n }, (_, k) => r[k] ?? "")))];
}
/** A table cell as plain text (it goes in a code block): no emphasis marks, a link as "text (url)". */
function plainInline(s) {
  return s
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => (t && t !== u ? `${t} (${u})` : u))
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function slackLine(l) {
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) return "———";
  const head = l.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
  if (head) return `*${slackInline(head[1]).replace(/\*/g, "")}*`;
  const item = l.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/);
  if (item) return `${item[1]}${item[2] == null ? "•" : item[2] === " " ? "☐" : "☑"} ${slackInline(item[3])}`;
  const quote = l.match(/^(\s*(?:>\s?)+)(.*)$/);
  if (quote) return quote[1] + slackLine(quote[2]);
  return slackInline(l);
}

function slackInline(s) {
  // Code spans and links are kept whole: set aside, then put back.
  const kept = [];
  const keep = (x) => `\u0000${kept.push(x) - 1}\u0000`;
  let t = s
    .replace(/`[^`]+`/g, keep)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, a, u) => keep(a ? `[${a}](${u})` : u))
    .replace(/\[[^\]]+\]\([^)\s]+[^)]*\)/g, keep)
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => keep(u))
    .replace(/https?:\/\/[^\s\u0000]+/g, keep)
    .replace(/<br\s*\/?>/gi, "\n");
  t = t
    .replace(/(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g, "\u0001$2\u0001")
    .replace(/(^|[^\w*\u0001])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, "$1_$2_")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\u0001/g, "*");
  return t.replace(/\u0000(\d+)\u0000/g, (_, k) => kept[Number(k)]);
}

/** A blockquote's markdown without its markers: `> ` (or `>`) off each line, up to 3 spaces of indent before it. */
export function unquote(raw) {
  return String(raw ?? "")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => l.replace(/^ {0,3}> ?/, ""))
    .join("\n");
}

/** The raw markdown of each top-level blockquote in marked's tokens, in page order (quotes inside lists count; nested quotes go with their parent). */
export function topQuotes(tokens) {
  const out = [];
  const walk = (list) => {
    for (const t of list || []) {
      if (t.type === "blockquote") out.push(t.raw);
      else (walk(t.tokens), walk(t.items));
    }
  };
  walk(tokens);
  return out;
}

/** Pin an unpinned id (at the end, so pins keep the order they were made in), or unpin it. */
export function togglePin(pins, id) {
  return pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
}

/** Split sections into the pinned ones, in pin order, and the rest as given. */
export function splitPinned(list, pins) {
  const at = new Map(pins.map((id, i) => [id, i]));
  return {
    pinned: list.filter((s) => at.has(s.id)).sort((a, b) => at.get(a.id) - at.get(b.id)),
    rest: list.filter((s) => !at.has(s.id)),
  };
}

// ── side panel order ───────────────────────────────────────────────────────────────────────────

/**
 * The side panel's order: the saved one, with any card it doesn't know yet
 * (a widget added later) at its default place, right after the default card
 * before it.
 */
export function mergeOrder(defaults, saved) {
  const out = [...new Set((Array.isArray(saved) ? saved : []).filter((id) => defaults.includes(id)))];
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    const prev = defaults.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
  });
  return out;
}

/**
 * Move one card up (dir < 0) or down past the next card that is on the page
 * (`present`); cards not shown keep their places. Unchanged at either end.
 */
export function moveAmong(order, id, dir, present = order) {
  const shown = order.filter((x) => present.includes(x) || x === id);
  const i = shown.indexOf(id);
  const other = shown[i + (dir < 0 ? -1 : 1)];
  if (i < 0 || !other) return order;
  const out = order.filter((x) => x !== id);
  out.splice(out.indexOf(other) + (dir < 0 ? 0 : 1), 0, id);
  return out;
}

/** Put a card just before another (or at the end when `before` is null): a drop. */
export function placeBefore(order, id, before) {
  if (id === before) return order;
  const out = order.filter((x) => x !== id);
  const at = before == null ? -1 : out.indexOf(before);
  out.splice(at < 0 ? out.length : at, 0, id);
  return out;
}

/**
 * What to paste into pi about a kanban card. On the Tasks board (the todo
 * tool's list) it names the todo and the next move for its column; on any
 * other board it hands over the card with where it sits.
 */
export function cardPrompt(k, column, { todo = false, board = "" } = {}) {
  const n = String(k.id || "").replace(/^#/, "");
  if (todo) {
    const what = n ? `todo #${n} (${k.title})` : `the todo "${k.title}"`;
    const why = String(k.note || "").replace(/^Blocked:\s*/, "");
    if (column === "Open") return `Claim ${what} and start on it.`;
    if (column === "Claimed") return `Continue ${what}${k.owner ? `, claimed by @${k.owner}` : ""}.`;
    if (column === "Blocked") return `Help unblock ${what}${why ? `: it's blocked on ${why}` : ""}.`;
    if (column === "Done") return `Review the work on ${what}.`;
  }
  const where = board ? `the "${board}" board, in ${column}` : column;
  return [`Let's work on ${k.id ? `${k.id} ` : ""}${k.title} (from ${where}).`, k.note || "", k.href || ""].filter(Boolean).join("\n");
}

// ── pipeline strip: dismissed or stale ───────────────────────────────────────

export const PIPE_STALE_MS = 30 * 60_000;

/**
 * Why the side panel's pipeline strip hides this pipeline, or "": "dismissed"
 * when its × was pressed at this very version (hidden[key] === sec.at, so an
 * update brings it back), "stale" when nobody updated it for PIPE_STALE_MS.
 */
export function pipeStripHidden(key, at, hidden, now = Date.now()) {
  if (hidden && hidden[key] === at) return "dismissed";
  const t = Date.parse(at);
  return t && now - t > PIPE_STALE_MS ? "stale" : "";
}

/** Record a dismissal, keeping the newest `max` (an object is insertion-ordered). */
export function dismissPipe(hidden, key, at, max = 100) {
  const next = { ...(hidden || {}) };
  delete next[key];
  next[key] = at;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete next[k];
  return next;
}
