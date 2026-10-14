import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { asQuote, boardMarks, boardMoves, boardSnapshot, cardPrompt, dismissPipe, pipeStripHidden, slackText, fuzzyScore, inlineTokens, matchKeys, mergeOrder, moveAmong, nextSeen, orderSessions, ownerSession, pipeRows, placeBefore, rankItems, splitPinned, togglePin, topQuotes, unquote, VIM_KEYS, waitingSessions, wrapLabel, buildTree, codeLayout, lineLabel, optionPrompt, optionsText, treeText, fenceFor, reviewLabel, reviewMessage, fmtBytes, fmtCount, gitSummary, infoRows, uniichatSummary } from "../extensions/canvas/nav.mjs";
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
  assert.deepEqual(matchKeys("yC"), { action: "yankSlack" }, "yC copies for Slack");
  assert.deepEqual(matchKeys("gr"), { action: "lastReply" });
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

test("asQuote: > on every line, a bare > on blank ones, trailing newlines dropped", () => {
  assert.equal(asQuote("*Done:* shipped.\n\nNext: docs\n\n"), "> *Done:* shipped.\n>\n> Next: docs");
  assert.equal(asQuote("  indented\n   "), ">   indented\n>");
  assert.equal(asQuote(""), ">");
});

test("blockquote copy: top-level quotes in page order, markers stripped, nested ones kept inside", () => {
  const raw1 = "> Posts as **me**.\n>\n> > *Done:* shipped `K`.\n> > Next: docs\n";
  const tokens = [
    { type: "paragraph", raw: "intro", tokens: [{ type: "text" }] },
    { type: "blockquote", raw: raw1, tokens: [{ type: "blockquote", raw: "> *Done:* …" }] },
    { type: "list", raw: "- a", items: [{ type: "list_item", tokens: [{ type: "blockquote", raw: "   > in a list" }] }] },
  ];
  assert.deepEqual(topQuotes(tokens), [raw1, "   > in a list"]);
  assert.equal(unquote(raw1), "Posts as **me**.\n\n> *Done:* shipped `K`.\n> Next: docs");
  assert.equal(unquote("   > in a list"), "in a list");
  assert.equal(unquote(">tight\nlazy line"), "tight\nlazy line");
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

test("pipeline wrap: two-line labels and rows that break between stages", () => {
  const m = (s) => s.length * 10; // 10px a character
  assert.deepEqual(wrapLabel("short", 100, m), ["short"]);
  assert.deepEqual(wrapLabel("allowBypass false start", 120, m), ["allowBypass", "false start"]);
  assert.deepEqual(wrapLabel("one two three four five six", 100, m), ["one two", "three fou…"]);
  assert.deepEqual(wrapLabel("app.host=vaww.example", 100, m), ["app.host=v", "aww.examp…"]);
  // Whole stages fill rows; a stage that doesn't fit starts the next row.
  const st = (cols, split = true) => ({ cols, col: 100, split });
  const ks = (rows) => rows.map((r) => r.map((u) => `${u.k}:${u.a}-${u.b}`));
  assert.deepEqual(ks(pipeRows([st(1), st(2), st(1)], 1000, 50)), [["0:0-1", "1:0-2", "2:0-1"]]);
  assert.deepEqual(ks(pipeRows([st(3), st(3), st(1)], 600, 50)), [["0:0-3"], ["1:0-3", "2:0-1"]]);
  // Wider than a row: even chunks on rows of their own; the last one shares with what follows.
  assert.deepEqual(ks(pipeRows([st(1), st(7), st(1)], 450, 50)), [["0:0-1"], ["1:0-4"], ["1:4-7", "2:0-1"]]);
  // A stage that may not split (lanes, a loop) keeps its own, overflowing row.
  assert.deepEqual(ks(pipeRows([st(1), st(7, false), st(1)], 450, 50)), [["0:0-1"], ["1:0-7"], ["2:0-1"]]);
});

test("pipeStripHidden: dismissed at this version, or stale after 30 minutes; dismissPipe keeps the newest", () => {
  const now = Date.parse("2026-10-12T18:00:00.000Z");
  const at = "2026-10-12T17:50:00.000Z";
  assert.equal(pipeStripHidden("s:p", at, {}, now), "");
  assert.equal(pipeStripHidden("s:p", at, { "s:p": at }, now), "dismissed");
  assert.equal(pipeStripHidden("s:p", "2026-10-12T17:59:00.000Z", { "s:p": at }, now), "", "an update brings it back");
  assert.equal(pipeStripHidden("s:p", "2026-10-12T17:29:00.000Z", {}, now), "stale");
  assert.equal(pipeStripHidden("s:p", "2026-10-12T17:31:00.000Z", {}, now), "");
  assert.equal(pipeStripHidden("s:p", "garbage", null, now), "");
  let h = {};
  for (const k of ["a", "b", "c", "d"]) h = dismissPipe(h, k, at, 3);
  assert.deepEqual(Object.keys(h), ["b", "c", "d"]);
  assert.deepEqual(Object.keys(dismissPipe(h, "b", "x", 3)), ["c", "d", "b"], "re-dismissed moves to newest");
});

test("slackText: markdown as Slack markup; links, code and quotes kept; tables as code blocks", () => {
  assert.equal(slackText("## Status: **done**"), "*Status: done*");
  assert.equal(slackText("**b**, *i*, _i_, ~~s~~"), "*b*, _i_, _i_, ~s~");
  assert.equal(slackText("`co**de**` and [a **b**](https://x.y/a_b*c) and https://z.q/**x**"), "`co**de**` and [a **b**](https://x.y/a_b*c) and https://z.q/**x**");
  assert.equal(slackText("<https://a.b> ![shot](https://i.png) ![](https://j.png)"), "https://a.b [shot](https://i.png) https://j.png");
  assert.equal(slackText("- one\n  * two **b**\n- [ ] todo\n- [x] done\n1. first"), "• one\n  • two *b*\n☐ todo\n☑ done\n1. first");
  assert.equal(slackText("a\n\n---\n\nb"), "a\n\n———\n\nb");
  assert.equal(slackText("> quoted **b**\n> - item"), "> quoted *b*\n> • item");
  assert.equal(slackText("2*3*4 and x * y, a<br>b"), "2*3*4 and x * y, a\nb", "a bare * is not emphasis");
  // Fenced code: untouched but its language; a ~~~ fence becomes ```.
  assert.equal(slackText('```ruby\nputs "**raw**"\n- not a bullet\n```\n~~~\nx\n~~~'), '```\nputs "**raw**"\n- not a bullet\n```\n```\nx\n```');
  // A table: aligned in a code block, cells as plain text, a link as "text (url)", an escaped pipe kept.
  assert.equal(
    slackText("| Name | Count | Link |\n|---|---:|---|\n| **Alpha** | 3 | [docs](https://d.e) |\n| Beta \\| two | 12 | |\n\nafter"),
    ["```", "Name        Count  Link", "----------  -----  ------------------", "Alpha       3      docs (https://d.e)", "Beta | two  12", "```", "", "after"].join("\n"),
  );
  assert.equal(slackText("| not | a table |"), "| not | a table |", "pipes without a separator row stay");
  assert.equal(asQuote(slackText("# Hi\n\n**x**\n")), "> *Hi*\n>\n> *x*");
});

test("codeLayout numbers lines and places bands and callouts", () => {
  const rows = codeLayout({ start: 40, code: "a\nb\nc\nd", highlight: [[41, 41]], notes: [{ from: 42, to: 43, text: "n", tone: "warn" }, { from: 40, to: 40, text: "m" }] });
  assert.deepEqual(rows.map((r) => r.n), [40, 41, 42, 43]);
  assert.deepEqual(rows.map((r) => r.hl), [false, true, false, false]);
  assert.deepEqual(rows.map((r) => r.tone ?? null), ["accent", null, "warn", "warn"], "a note range tints its lines; no tone means accent");
  assert.deepEqual(rows.map((r) => r.notes.map((n) => n.text)), [["m"], [], [], ["n"]], "a callout goes under the last line of its range");
  assert.equal(codeLayout({ code: "" }).length, 1);
  assert.equal(lineLabel(4, 4), "L4");
  assert.equal(lineLabel(4, 9), "L4–9");
});

test("buildTree nests paths, folders first, merges lone folders and counts tags", () => {
  const t = buildTree([
    { path: "src/lib/util/b.ts", tag: "changed" },
    { path: "src/lib/util/a10.ts" },
    { path: "src/lib/util/a9.ts", tag: "added" },
    { path: "README.md", tag: "changed" },
    { path: "docs/", note: "later" },
    { path: "bin/run" },
    { path: "bin/x/y" },
  ]);
  assert.deepEqual(t.map((n) => n.name), ["bin", "docs", "src/lib/util", "README.md"], "folders first; a chain of lone folders merges");
  const src = t[2];
  assert.deepEqual(src.kids.map((n) => n.name), ["a9.ts", "a10.ts", "b.ts"], "natural order");
  assert.deepEqual(src.counts, { added: 1, changed: 1 });
  assert.equal(src.files, 3);
  assert.equal(src.path, "src/lib/util");
  assert.equal(t[1].note, "later");
  assert.equal(t[1].dir, true, "a trailing / is a folder");
  assert.deepEqual(t[0].kids.map((n) => n.name), ["x", "run"], "a folder with a file beside it does not merge");
  assert.equal(buildTree([{ path: "a", note: "n" }, { path: "a/b" }])[0].dir, true, "a path that has children is a folder");
});

test("treeText draws the tree like the tree command", () => {
  const text = treeText({ root: "repo", entries: [{ path: "src/a.ts", tag: "added" }, { path: "src/b.ts", note: "why" }, { path: "z.md" }] });
  assert.equal(text, ["repo/", "├── src/", "│   ├── a.ts [added]", "│   └── b.ts — why", "└── z.md"].join("\n"));
});

test("options copy as markdown and Pick builds a prompt", () => {
  const spec = { question: "Which store?", options: [{ label: "SQLite", recommended: true, cost: "S", summary: "one file", pros: ["simple"], cons: ["one writer"], scores: { Effort: 1 } }, { label: "Postgres", pick: "Use Postgres via RDS" }] };
  assert.equal(optionPrompt(spec, 0), 'Go with option A: SQLite (for "Which store?")');
  assert.equal(optionPrompt(spec, 1), "Use Postgres via RDS", "pick wins");
  assert.equal(optionPrompt(spec, 5), "");
  assert.equal(optionsText(spec), "**Which store?**\n\n**A. SQLite** (recommended) — S\none file\n- ✓ simple\n- ✗ one writer\n- Effort: 1/5\n\n**B. Postgres**");
});

test("reviewLabel: file and lines, the old side marked, a range across sides spelled out", () => {
  assert.equal(reviewLabel({ file: "app.rb", start: { side: "new", n: 12 }, end: { side: "new", n: 12 } }), "app.rb:12");
  assert.equal(reviewLabel({ file: "app.rb", start: { side: "", n: 4 }, end: { side: "", n: 9 } }), "app.rb:4-9");
  assert.equal(reviewLabel({ file: "app.rb", start: { side: "old", n: 9 }, end: { side: "old", n: 9 } }), "app.rb:9 (old)");
  assert.equal(reviewLabel({ file: "app.rb", start: { side: "old", n: 9 }, end: { side: "new", n: 11 } }), "app.rb: old 9 to new 11");
  assert.equal(reviewLabel({ start: { side: "", n: 1 } }), "code:1");
});

test("fenceFor: longer than any backtick run inside", () => {
  assert.equal(fenceFor("plain"), "```");
  assert.equal(fenceFor("a ```` b"), "`````");
});

test("reviewMessage: verdict and count, summary, then each comment with its lines quoted", () => {
  const comments = [
    { file: "app/c.rb", start: { side: "", n: 9 }, end: { side: "", n: 9 }, quote: ["if coupon.expires_at < Time.now"], lang: "ruby", text: " Use `expired?`: nil raises. ", title: "Bug" },
    { file: "lib/x.rb", start: { side: "new", n: 3 }, end: { side: "new", n: 4 }, quote: ["+a = 1", "+b = ```"], lang: "diff", text: "Why?" },
  ];
  assert.equal(
    reviewMessage({ verdict: "changes", summary: "Close, two things.\n", comments }),
    ["Review from the canvas: **Request changes** (2 comments)", "", "Close, two things.", "", '**`app/c.rb:9`** in "Bug"', "```ruby", "if coupon.expires_at < Time.now", "```", "Use `expired?`: nil raises.", "", "**`lib/x.rb:3-4`**", "````diff", "+a = 1\n+b = ```", "````", "Why?"].join("\n"),
  );
  assert.equal(reviewMessage({ verdict: "approve" }), "Review from the canvas: **Approve**");
  assert.equal(reviewMessage({ verdict: "bogus", comments: [comments[1]] }).split("\n")[0], "Review from the canvas: **Comment** (1 comment)");
  const long = reviewMessage({ comments: [{ file: "f", start: { side: "", n: 1 }, end: { side: "", n: 40 }, quote: Array.from({ length: 40 }, (_, i) => `l${i}`), text: "t" }] });
  assert.match(long, /l29\n…\n```/);
  assert.doesNotMatch(long, /l30/);
});

test("fmtCount and fmtBytes", () => {
  assert.deepEqual([fmtCount(950), fmtCount(9600), fmtCount(96000), fmtCount(200000), fmtCount(1250000), fmtCount(null)], ["950", "9.6k", "96k", "200k", "1.25M", "?"]);
  assert.deepEqual([fmtBytes(900), fmtBytes(94208), fmtBytes(3.4 * 1048576), fmtBytes(undefined)], ["900 B", "92 KB", "3.4 MB", "?"]);
});

test("gitSummary: branch, ahead/behind, dirt or clean", () => {
  const g = { branch: "master", oid: "abcdef123", upstream: "origin/master", ahead: 1, behind: 0, staged: 0, modified: 2, untracked: 4, conflicts: 0 };
  assert.equal(gitSummary(g), "master ↑1 · 2 modified, 4 untracked");
  assert.equal(gitSummary({ ...g, ahead: 0, modified: 0, untracked: 0 }), "master · clean");
  assert.equal(gitSummary({ ...g, branch: "(detached)", upstream: "", ahead: 0, behind: 3, modified: 0, untracked: 0, conflicts: 1 }), "detached at abcdef1 ↓3 (no upstream) · 1 conflicted");
  assert.equal(gitSummary(null), "");
});

test("uniichatSummary: on with stats, off, loaded without stats", () => {
  assert.equal(uniichatSummary({ enabled: true, viewLines: 412, viewBytes: 94208, viewLowBytes: 65536, viewHighBytes: 131072, messages: 1203, logBytes: 3.4 * 1048576, queued: 0, inFlight: 1, requests: 12, failures: 0 }), "on · view 412 lines, 92 KB (target 64 KB–128 KB) · log 1,203 messages, 3.4 MB · queue 0 (1 in flight) · 12 requests");
  assert.equal(uniichatSummary({ enabled: false }), "off (/uniichat on to start)");
  assert.equal(uniichatSummary(null), "loaded, no stats");
  assert.equal(uniichatSummary(undefined), "");
});

test("infoRows: the panel's rows from /info", () => {
  const d = {
    live: true,
    started: "S",
    info: { model: { provider: "anthropic", id: "claude-opus-5", name: "Opus 5", reasoning: true }, thinking: "high", context: { tokens: 96000, window: 200000, percent: 48.4 }, prompts: 37, replies: 1, cost: 4.123, at: "A" },
    git: { branch: "master", upstream: "o/m", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, last: { sha: "78e0392", subject: "fix it", date: "D" } },
  };
  const ago = (t) => `<${t}>`;
  assert.deepEqual(infoRows(d, ago), [
    { key: "model", label: "Model", value: "Opus 5 · thinking high", note: "anthropic · claude-opus-5" },
    { key: "context", label: "Context", value: "48% · 96k / 200k", percent: 48.4 },
    { key: "session", label: "Session", value: "37 prompts · 1 reply · $4.12", note: "started <S> · as of <A>" },
    { key: "repo", label: "Repo", value: "master · clean", note: "78e0392 fix it · <D>" },
    { key: "uniichat", label: "UniiChat", value: "not loaded in this session" },
  ]);
  const bare = infoRows({ live: true, info: { model: { id: "m", reasoning: false }, context: { tokens: null, window: 128000, percent: null }, prompts: 0, replies: 0, cost: 0, uniichat: { enabled: false } }, git: null }, ago);
  assert.equal(bare[0].value, "m · no thinking");
  assert.deepEqual(bare[1], { key: "context", label: "Context", value: "? · ? / 128k", note: "unknown until the next reply (just compacted)" });
  assert.equal(bare[2].value, "0 prompts · 0 replies");
  assert.equal(bare[3].value, "not a git repo");
  assert.equal(bare[4].value, "off (/uniichat on to start)");
  assert.deepEqual(infoRows({ live: true, info: null, git: null }).map((r) => r.key), ["repo"]);
});
