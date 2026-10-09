import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fuzzyScore, matchKeys, nextSeen, orderSessions, rankItems, VIM_KEYS, waitingSessions } from "../extensions/canvas/nav.mjs";
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
  assert.deepEqual(matchKeys("h"), { action: "toSide" });
  assert.deepEqual(matchKeys("l"), { action: "toMain" });
  assert.deepEqual(matchKeys("gj"), {});
  assert.deepEqual(matchKeys("x"), {});
  assert.deepEqual(matchKeys(""), {});
});
