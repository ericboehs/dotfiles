import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { boardMarks, boardMoves, boardSnapshot, cardPrompt, fuzzyScore, inlineTokens, matchKeys, mergeOrder, moveAmong, nextSeen, orderSessions, ownerSession, placeBefore, rankItems, splitPinned, togglePin, VIM_KEYS, waitingSessions } from "../extensions/canvas/nav.mjs";
import { mix, prettyName, readPair, swatch, systemTheme, themeMode, themeVars } from "../extensions/canvas/theme.mjs";
import { parseColors } from "../extensions/canvas/build-themes.mjs";

const THEMES = JSON.parse(readFileSync(new URL("../extensions/canvas/themes.json", import.meta.url), "utf8")).themes;

// ── theme.mjs ────────────────────────────────────────────────────────────────

test("mix blends hex colours and survives bad input", () => {
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#102030", "#102030", 0.3), "#102030");
  assert.equal(mix("#ff0000", "nope", 0.5), "#ff0000");
  assert.equal(mix("#FFFFFF", "#000000", 0), "#ffffff");
});

test("prettyName and themeMode", () => {
  assert.equal(prettyName("tokyo-night"), "Tokyo Night");
  assert.equal(prettyName("retro-82"), "Retro 82");
  assert.equal(themeMode({ mode: "light", background: "#000000" }), "light", "an explicit mode wins");
  assert.equal(themeMode({ background: "#1a1b26" }), "dark");
  assert.equal(themeMode({ background: "#faf4ed" }), "light");
});

test("themeVars maps a palette onto every page variable, Omarchy's ANSI order included", () => {
  const c = THEMES["tokyo-night"];
  const v = themeVars(c);
  for (const k of ["--bg", "--card", "--ink", "--dim", "--line", "--soft", "--code", "--accent", "--ok", "--warn", "--bad", "--c1", "--c8", "--t0", "--t15", "--hl-kw"]) assert.match(v[k], /^#[0-9a-f]{6}$/i, k);
  assert.equal(v["--card"], c.background);
  assert.equal(v["--bg"], c.dark_background);
  assert.equal(v["--ink"], c.foreground);
  assert.equal(v["--accent"], c.accent);
  assert.deepEqual([v["--t0"], v["--t1"], v["--t7"], v["--t8"], v["--t15"]], [c.background, c.red, c.foreground, c.muted, c.bright_foreground]);
  // A sparse palette still fills everything.
  const sparse = themeVars({ background: "#ffffff", foreground: "#000000" });
  assert.equal(Object.values(sparse).filter((x) => !/^#[0-9a-f]{6}$/i.test(x)).length, 0);
});

test("every bundled theme yields a full, valid set of variables", () => {
  assert.ok(Object.keys(THEMES).length >= 20);
  const modes = { dark: 0, light: 0 };
  const all = Object.keys(themeVars({ background: "#ffffff", foreground: "#000000" }));
  for (const [name, c] of Object.entries(THEMES)) {
    modes[themeMode(c)]++;
    const v = themeVars(c);
    assert.deepEqual(Object.keys(v), all, name);
    for (const [k, x] of Object.entries(v)) assert.match(x, /^#[0-9a-f]{6}$/i, `${name} ${k}`);
    assert.ok(swatch(c).length >= 4, name);
  }
  assert.ok(modes.dark > 0 && modes.light > 0, "both slots have choices");
});

test("readPair keeps known themes in the right slot and falls back to canvas", () => {
  assert.deepEqual(readPair(null), { dark: "canvas", light: "canvas" });
  assert.deepEqual(readPair("{broken"), { dark: "canvas", light: "canvas" });
  assert.deepEqual(readPair({ dark: "tokyo-night", light: "flexoki-light" }, THEMES), { dark: "tokyo-night", light: "flexoki-light" });
  assert.deepEqual(readPair({ dark: "flexoki-light", light: "gone-theme" }, THEMES), { dark: "canvas", light: "canvas" }, "a light theme can't sit in the dark slot");
});

test("parseColors reads Omarchy's flat colors.toml", () => {
  assert.deepEqual(parseColors('mode = "dark"\n# c\naccent = "#7aa2f7"\n\nbright_red = "#ff7a93"\nbad line'), { mode: "dark", accent: "#7aa2f7", bright_red: "#ff7a93" });
});

test("systemTheme: a whole palette or null, and a safe name", () => {
  const toml = 'mode = "dark"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\n';
  assert.deepEqual(systemTheme(toml, "tokyo-night\n"), { name: "tokyo-night", colors: { mode: "dark", background: "#1a1b26", foreground: "#a9b1d6" } });
  assert.equal(systemTheme(toml, "").name, "system", "no theme.name");
  assert.equal(systemTheme(toml, "<b>evil</b> name").name, "bevilbname", "only name characters survive");
  assert.equal(systemTheme('mode = "dark"\nbackground = "#1a1b26"\n', "x"), null, "no foreground: mid-switch");
  assert.equal(systemTheme("", "x"), null);
  assert.equal(themeMode(systemTheme('background = "#fffcf0"\nforeground = "#100f0f"', "x").colors), "light", "no mode line: judged by background");
});

// ── nav.mjs ──────────────────────────────────────────────────────────────────

const S = (id, activity, at, extra = {}) => ({ id, live: true, activity, activityAt: at, updated: 0, ...extra });

test("waitingSessions: other live sessions that need you and changed since you looked", () => {
  const list = [
    S("me", "done", "2026-10-09T18:05:00Z"),
    S("a", "done", "2026-10-09T18:04:00Z"),
    S("b", "blocked", "2026-10-09T18:01:00Z"),
    S("c", "working", "2026-10-09T18:06:00Z"),
    S("d", "error", "2026-10-09T18:02:00Z"),
    S("e", "done", "2026-10-09T17:00:00Z"),
    S("f", "done", "2026-10-09T18:03:00Z", { live: false }),
  ];
  const seen = { e: Date.parse("2026-10-09T17:30:00Z"), a: Date.parse("2026-10-09T18:00:00Z") };
  assert.deepEqual(
    waitingSessions(list, seen, "me").map((s) => s.id),
    ["b", "d", "a"],
    "blocked, then error, then done; the current page, working, seen-since and ended ones are left out",
  );
  assert.deepEqual(waitingSessions(list, { ...seen, a: Date.parse("2026-10-09T18:10:00Z") }, "me").map((s) => s.id), ["b", "d"], "visiting a page clears its chip");
});

test("nextSeen seeds everything on the first run and drops sessions that are gone", () => {
  const list = [S("a", "done"), S("b", "working")];
  assert.deepEqual(nextSeen(null, list, 5), { a: 5, b: 5 });
  assert.deepEqual(nextSeen({ a: 1, gone: 2 }, list, 5), { a: 1 });
});

test("orderSessions: waiting first, then live by recency, then ended by end time", () => {
  const list = [
    S("old", "ended", "", { live: false, ended: "2026-10-01T00:00:00Z" }),
    S("live1", "working", "2026-10-09T10:00:00Z"),
    S("me", "done", "2026-10-09T12:00:00Z"),
    S("new", "ended", "", { live: false, ended: "2026-10-08T00:00:00Z" }),
    S("live2", "idle", "2026-10-09T11:00:00Z"),
    S("w", "blocked", "2026-10-09T09:00:00Z"),
  ];
  const waiting = waitingSessions(list, {}, "me");
  assert.deepEqual(orderSessions(list, waiting, "me").map((s) => s.id), ["w", "live2", "live1", "new", "old"]);
});

test("fuzzyScore and rankItems match titles in order, favouring word starts", () => {
  assert.equal(fuzzyScore("", "anything"), 0);
  assert.equal(fuzzyScore("xz", "dotfiles"), -1);
  assert.ok(fuzzyScore("ct", "change theme") > fuzzyScore("ct", "dotfiles canvas tool"), "word starts beat scattered letters");
  const items = [{ label: "Copy link to this page" }, { label: "Change theme…" }, { label: "dotfiles" }, { label: "Fold all sections" }];
  assert.deepEqual(rankItems(items, "theme").map((x) => x.label), ["Change theme…"]);
  assert.deepEqual(rankItems(items, "").map((x) => x.label), items.map((x) => x.label), "an empty query keeps the order");
  assert.equal(rankItems(items, "fold")[0].label, "Fold all sections");
});

test("vim key table: unique, prefix-free, every action documented", () => {
  const seqs = VIM_KEYS.map((k) => k.keys);
  assert.equal(new Set(seqs).size, seqs.length, "no sequence twice");
  for (const a of seqs) for (const b of seqs) if (a !== b) assert.ok(!b.startsWith(a), `${a} would shadow ${b}`);
  for (const action of new Set(VIM_KEYS.map((k) => k.action))) assert.ok(VIM_KEYS.some((k) => k.action === action && k.help), `${action} shows in the ? list`);
  assert.ok(seqs.includes("yy") && seqs.includes("yc") && !seqs.includes("yf"), "yy is Clippy now; yf is gone");
  assert.ok(seqs.includes("h") && seqs.includes("l"));
});

test("matchKeys: actions, prefixes, misses", () => {
  assert.deepEqual(matchKeys("j"), { action: "next" });
  assert.deepEqual(matchKeys("G"), { action: "bottom" });
  assert.deepEqual(matchKeys("g"), { pending: true });
  assert.deepEqual(matchKeys("gg"), { action: "top" });
  assert.deepEqual(matchKeys("za"), { action: "toggle" });
  assert.deepEqual(matchKeys("o"), { action: "toggle" });
  assert.deepEqual(matchKeys("Enter"), { action: "toggle" });
  assert.deepEqual(matchKeys("zM"), { action: "foldAll" });
  assert.deepEqual(matchKeys("yy"), { action: "yankFile" });
  assert.deepEqual(matchKeys("yf"), {});
  assert.deepEqual(matchKeys("h"), { action: "toMain" }); // the side panel is on the right
  assert.deepEqual(matchKeys("l"), { action: "toSide" });
  assert.deepEqual(matchKeys("gj"), {});
  assert.deepEqual(matchKeys("x"), {});
  assert.deepEqual(matchKeys(""), {});
});

test("inlineTokens: code, bold and http(s) links; everything else stays text", () => {
  assert.deepEqual(inlineTokens("Fix `web.ts:699` **now**, see [#12](https://x.test/12)"), [
    { t: "text", v: "Fix " },
    { t: "code", v: "web.ts:699" },
    { t: "text", v: " " },
    { t: "b", v: "now" },
    { t: "text", v: ", see " },
    { t: "a", v: "#12", href: "https://x.test/12" },
  ]);
  assert.deepEqual(inlineTokens("[x](javascript:alert(1)) <b>hi</b>"), [{ t: "text", v: "[x](javascript:alert(1)) <b>hi</b>" }], "only http(s) links; tags are text");
  assert.deepEqual(inlineTokens(""), []);
});

test("ownerSession: live wins, else the newest ended; names and ties are not sessions", () => {
  const list = [
    { id: "aaaa-old-b7c2", live: false, ended: "2026-10-01T00:00:00Z" },
    { id: "aaaa-new-b7c2", live: false, ended: "2026-10-09T00:00:00Z" },
    { id: "bbbb-kb01", live: true, activity: "working" },
    { id: "cccc-x1y2", live: true },
    { id: "dddd-x1y2", live: true },
  ];
  assert.equal(ownerSession("pi-b7c2", list).session.id, "aaaa-new-b7c2");
  assert.equal(ownerSession("pi-b7c2", list).state, "ended");
  assert.deepEqual(ownerSession("pi-kb01", list, "bbbb-kb01"), { session: list[2], state: "working", me: true });
  assert.equal(ownerSession("pi-x1y2", list), null, "two live sessions share the suffix");
  assert.equal(ownerSession("eric", list), null);
  assert.equal(ownerSession("pi-zzzz", list), null);
  assert.equal(ownerSession("pi-cccc", [{ id: "s-cccc", live: true }]).state, "done", "live with no activity reads as your turn");
});

test("boardMoves and boardMarks: new and moved cards, kept for a while, carried while unseen", () => {
  const before = [{ label: "Open", cards: [{ id: "#1", title: "a" }, { title: "loose" }] }, { label: "Done", cards: [] }];
  const after = [{ label: "Open", cards: [{ title: "loose" }, { id: "#3", title: "c" }] }, { label: "Done", cards: [{ id: "#1", title: "a" }] }];
  assert.deepEqual(boardMoves(null, after), {}, "nothing on a first look");
  assert.deepEqual(boardMoves(boardSnapshot(before), after), { "id:#3": "new", "id:#1": "Done" });
  const dup = [{ label: "A", cards: [{ id: "#7", title: "x" }] }, { label: "B", cards: [{ id: "#7", title: "y" }] }];
  assert.deepEqual(boardSnapshot(dup), { "id:#7": null });
  assert.deepEqual(boardMoves(boardSnapshot(before), dup), {}, "a shared id gets no mark");
  assert.deepEqual(boardMoves(boardSnapshot(dup), [{ label: "B", cards: [{ id: "#7", title: "y" }] }]), {}, "nor once it is single again");

  const t0 = 1_000_000;
  const first = boardMarks(undefined, before, { now: t0 });
  assert.deepEqual(first.moves, {});
  const second = boardMarks(first.save, after, { now: t0 + 1000 });
  assert.deepEqual(second.moves, { "id:#3": "new", "id:#1": "Done" });
  assert.equal(boardMarks(second.save, after, { now: t0 + 60e3 }).save, null, "a redraw stores nothing");
  assert.deepEqual(boardMarks(second.save, after, { now: t0 + 60e3 }).moves, second.moves, "and keeps the marks");
  assert.deepEqual(boardMarks(second.save, after, { now: t0 + 16 * 60e3 }).moves, {}, "gone after 15 minutes");

  // In a background tab: the clock waits, and unseen marks survive the next change.
  const hidden = boardMarks(first.save, after, { now: t0, visible: false });
  assert.equal(hidden.save.at, 0);
  const later = [{ label: "Open", cards: [{ title: "loose" }, { id: "#3", title: "c" }, { id: "#4", title: "d" }] }, { label: "Done", cards: [{ id: "#1", title: "a" }] }];
  const next = boardMarks(hidden.save, later, { now: t0 + 3600e3, visible: false });
  assert.deepEqual(next.moves, { "id:#3": "new", "id:#1": "Done", "id:#4": "new" });
  const seen = boardMarks(next.save, later, { now: t0 + 7200e3 });
  assert.deepEqual(seen.moves, next.moves, "still shown when finally seen");
  assert.equal(seen.save.at, t0 + 7200e3, "and the clock starts then");
});

test("pins: toggle keeps pin order; split puts pinned first in that order", () => {
  assert.deepEqual(togglePin([], "a"), ["a"]);
  assert.deepEqual(togglePin(["a", "b"], "c"), ["a", "b", "c"], "a new pin goes last");
  assert.deepEqual(togglePin(["a", "b", "c"], "b"), ["a", "c"]);
  const list = [{ id: "new" }, { id: "mid" }, { id: "old" }];
  const { pinned, rest } = splitPinned(list, ["old", "gone", "new"]);
  assert.deepEqual(pinned.map((s) => s.id), ["old", "new"], "pin order, missing ids skipped");
  assert.deepEqual(rest.map((s) => s.id), ["mid"]);
  assert.deepEqual(splitPinned(list, []).rest, list);
  assert.equal(matchKeys("p").action, "pin");
});

test("side panel order: saved order kept, new cards at their default place, moves skip absent cards", () => {
  const D = ["_contents", "jobs", "tasks", "agents", "files"];
  assert.deepEqual(mergeOrder(D, null), D);
  assert.deepEqual(mergeOrder(D, "junk"), D);
  // "jobs" is new since the order was saved: it lands after its default neighbour (Contents); unknown ids drop.
  assert.deepEqual(mergeOrder(D, ["agents", "_contents", "gone", "tasks", "files", "agents"]), ["agents", "_contents", "jobs", "tasks", "files"]);
  assert.deepEqual(mergeOrder(D, ["files"]), D);
  // J / K step past the next card on the page; a card not shown keeps its slot.
  assert.deepEqual(moveAmong(D, "agents", -1), ["_contents", "jobs", "agents", "tasks", "files"]);
  assert.deepEqual(moveAmong(D, "agents", -1, ["_contents", "jobs", "agents", "files"]), ["_contents", "agents", "jobs", "tasks", "files"]);
  assert.deepEqual(moveAmong(D, "_contents", 1, ["_contents", "agents"]), ["jobs", "tasks", "agents", "_contents", "files"]);
  assert.equal(moveAmong(D, "_contents", -1), D);
  assert.equal(moveAmong(D, "files", 1), D);
  // A drop: before a card, or at the end.
  assert.deepEqual(placeBefore(D, "files", "jobs"), ["_contents", "files", "jobs", "tasks", "agents"]);
  assert.deepEqual(placeBefore(D, "_contents", null), ["jobs", "tasks", "agents", "files", "_contents"]);
  assert.equal(placeBefore(D, "jobs", "jobs"), D);
  assert.equal(matchKeys("J").action, "moveDown");
  assert.equal(matchKeys("K").action, "moveUp");
});

test("cardPrompt: the todo's next move by column, or a hand-over for other boards", () => {
  const t = { id: "#5", title: "Write the README" };
  assert.equal(cardPrompt(t, "Open", { todo: true }), "Claim todo #5 (Write the README) and start on it.");
  assert.equal(cardPrompt({ ...t, owner: "pi-b7c2" }, "Claimed", { todo: true }), "Continue todo #5 (Write the README), claimed by @pi-b7c2.");
  assert.equal(cardPrompt({ ...t, note: "Blocked: waiting on review" }, "Blocked", { todo: true }), "Help unblock todo #5 (Write the README): it's blocked on waiting on review.");
  assert.equal(cardPrompt(t, "Done", { todo: true }), "Review the work on todo #5 (Write the README).");
  assert.equal(cardPrompt({ title: "No id" }, "Open", { todo: true }), 'Claim the todo "No id" and start on it.');
  assert.equal(
    cardPrompt({ id: "#212", title: "Coupon before tax", note: "p95 3s", href: "https://x.test/212" }, "New", { board: "Cart bugs" }),
    'Let\'s work on #212 Coupon before tax (from the "Cart bugs" board, in New).\np95 3s\nhttps://x.test/212',
  );
  assert.equal(cardPrompt({ title: "Loose" }, "Doing"), "Let's work on Loose (from Doing).");
});
