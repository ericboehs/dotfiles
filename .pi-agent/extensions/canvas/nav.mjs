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

/** Text as a markdown blockquote (⌥-click on a copy button): "> " on every line, a bare ">" on blank ones. */
export function asQuote(text) {
  return String(text ?? "")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
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
