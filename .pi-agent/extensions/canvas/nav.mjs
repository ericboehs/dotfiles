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
  { group: "Move", keys: "n", action: "nextChanged", help: "next section changed while folded (the dot)" },
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
