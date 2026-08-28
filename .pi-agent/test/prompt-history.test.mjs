/**
 * Smoke tests for the shared prompt history.
 *
 * The whole extension is about one file being read and written by several pis
 * at once, so the tests drive it through a temporary agent dir: one mount is a
 * pi, two mounts over the same dir are two panes.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";
const CTRL_R = "\x12";
const CTRL_U = "\x15";
const KEYS = {
  "tui.editor.cursorUp": UP,
  "tui.editor.cursorDown": DOWN,
  "tui.editor.historyPrevious": "\x10",
  "tui.editor.historyNext": "\x0e",
};

/** Rendered overlay rows, minus the query and help lines. */
function rows(overlay, width = 60) {
  return overlay.render(width).slice(0, -2);
}

/** The query line, which also carries the counter and the fuzzy flag. */
function status(overlay, width = 60) {
  return overlay
    .render(width)
    .at(-2)
    .replace(/\u001b_pi:c\u0007/g, "") // the cursor marker pi places for us
    .replace(/\s+/g, " ")
    .trim();
}

function type(overlay, text) {
  for (const char of text) overlay.handleInput(char);
}

/** Load a fresh copy: the extension keeps its offset and seen set in closure. */
async function loadExtension() {
  const url = new URL("../extensions/prompt-history.ts", import.meta.url);
  url.search = `?t=${Math.random()}`;
  return (await import(url.href)).default;
}

/**
 * Mount one "pi" against `agentDir`.
 *
 * The fake editor records addToHistory in call order, which is the reverse of
 * what Up walks: pi-tui unshifts, so the last call is the first entry offered.
 */
async function mount(agentDir, { cwd = "/repo/a" } = {}) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extension = await loadExtension();

  const handlers = new Map();
  const shortcuts = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerShortcut: (key, options) => shortcuts.set(key, options),
  };
  extension(pi);

  let installed;
  const added = [];
  const keystrokes = [];
  const notices = [];
  const editorText = [];
  let overlay;
  const base = () => ({
    getText: () => "",
    setText: () => {},
    handleInput: (data) => keystrokes.push(data),
    addToHistory: (text) => added.push(text),
  });

  // Plain-text theme: assertions read the rendered lines directly.
  const theme = { fg: (_color, text) => text };
  const tui = { requestRender: () => {} };
  const renders = [];
  const editorTui = { requestRender: () => renders.push(true) };

  const ctx = {
    mode: "tui",
    cwd,
    ui: {
      getEditorComponent: () => installed,
      setEditorComponent: (factory) => {
        installed = factory;
      },
      notify: (message) => notices.push(message),
      setEditorText: (text) => editorText.push(text),
      custom: (factory) =>
        new Promise((resolve) => {
          overlay = factory(tui, theme, {}, resolve);
          overlay.focused = true;
        }),
    },
  };

  const keybindings = { matches: (data, id) => KEYS[id] === data };

  return {
    added,
    keystrokes,
    notices,
    editorText,
    renders,
    ctx,
    /** Pretend another extension already owns the editor (cursor-focus does). */
    presetEditor: (factory) => {
      installed = factory ?? base;
    },
    start: () => handlers.get("session_start")({}, ctx),
    /** Build the editor pi would build, and hand back the wrapped instance. */
    openEditor: () => installed(editorTui, {}, keybindings),
    submit: (text, overrides = {}) =>
      handlers.get("input")({ text, source: "interactive", ...overrides }, ctx),
    /** Open the Ctrl+R overlay; returns it plus the promise the handler is on. */
    search: () => {
      overlay = undefined;
      const done = shortcuts.get("ctrl+r").handler(ctx);
      return { overlay, done };
    },
  };
}

function newAgentDir() {
  return mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
}

function historyLines(agentDir) {
  const raw = readFileSync(join(agentDir, "prompt-history.jsonl"), "utf8");
  return raw.trim().split("\n").map(JSON.parse);
}

function seedFile(agentDir, records) {
  writeFileSync(
    join(agentDir, "prompt-history.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

test("submitted prompts are appended with their project", async () => {
  const dir = newAgentDir();
  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  pi.submit("  fix the flaky test  ");

  const [record] = historyLines(dir);
  assert.equal(record.text, "fix the flaky test", "stored trimmed");
  assert.equal(record.cwd, "/repo/a");
  assert.ok(record.t > 0, "timestamped for later ranking");
});

test("noise stays out of the file", async () => {
  const dir = newAgentDir();
  const pi = await mount(dir);
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  pi.submit("/model");
  pi.submit("   ");
  pi.submit("injected", { source: "extension" });
  pi.submit("from a script", { source: "rpc" });
  pi.submit("/export report.html");

  assert.deepEqual(
    historyLines(dir).map((record) => record.text),
    ["/export report.html"],
    "bare commands, blanks and non-typed input are skipped; commands with args are not",
  );
});

test("a new pi starts with the prompts of the ones before it", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    { t: 1, cwd: "/repo/a", text: "oldest" },
    { t: 2, cwd: "/repo/a", text: "middle" },
    { t: 3, cwd: "/repo/a", text: "newest" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  assert.deepEqual(
    pi.added,
    ["oldest", "middle", "newest"],
    "fed oldest first, so the first Up lands on the newest prompt",
  );
});

test("this project's prompts come before the rest of the machine", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    { t: 1, cwd: "/repo/a", text: "here, old" },
    { t: 2, cwd: "/repo/b", text: "elsewhere, newer" },
    { t: 3, cwd: "/repo/a", text: "here, newest" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  assert.deepEqual(
    [...pi.added].reverse(),
    ["here, newest", "here, old", "elsewhere, newer"],
    "Up walks this repo first, then falls through to other projects",
  );
});

test("repeated prompts are seeded once", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    { t: 1, cwd: "/repo/a", text: "run the tests" },
    { t: 2, cwd: "/repo/a", text: "something else" },
    { t: 3, cwd: "/repo/a", text: "run the tests" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  assert.deepEqual(pi.added, ["something else", "run the tests"]);
});

test("Up picks up a prompt typed in another pane since boot", async () => {
  const dir = newAgentDir();
  const pane1 = await mount(dir, { cwd: "/repo/a" });
  pane1.presetEditor();
  pane1.start();
  const editor = pane1.openEditor();

  const pane2 = await mount(dir, { cwd: "/repo/a" });
  pane2.presetEditor();
  pane2.start();
  pane2.openEditor();
  pane2.submit("typed in the other pane");

  assert.deepEqual(pane1.added, [], "nothing arrives until the ring is consulted");

  editor.handleInput(UP);
  assert.deepEqual(pane1.added, ["typed in the other pane"]);
  assert.deepEqual(pane1.keystrokes, [UP], "the key still reaches the editor");

  editor.handleInput(UP);
  editor.handleInput(DOWN);
  editor.handleInput(UP);
  assert.deepEqual(pane1.added, ["typed in the other pane"], "never twice, and never mid-browse");

  pane2.submit("and another one");
  editor.handleInput("x");
  editor.handleInput(UP);
  assert.deepEqual(pane1.added, ["typed in the other pane", "and another one"], "a new browse looks again");
});

test("a pi does not re-import its own prompts", async () => {
  const dir = newAgentDir();
  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  const editor = pi.openEditor();

  pi.submit("my own prompt");
  editor.handleInput(UP);

  assert.deepEqual(pi.added, [], "pi's own editor already recorded it");
});

test("reload rewraps the editor underneath instead of stacking", async () => {
  const dir = newAgentDir();
  seedFile(dir, [{ t: 1, cwd: "/repo/a", text: "only prompt" }]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  let baseCalls = 0;
  pi.presetEditor(() => {
    baseCalls++;
    return {
      getText: () => "",
      setText: () => {},
      handleInput: () => {},
      addToHistory: (text) => pi.added.push(text),
    };
  });

  pi.start();
  pi.start();
  pi.start();
  pi.openEditor();

  assert.equal(baseCalls, 1, "the underlying editor is built once");
  assert.deepEqual(pi.added, ["only prompt"], "and seeded once, not once per reload");
});

test("ctrl+r matches what you actually typed, and enter loads it", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    // Every one of these is a k-a-m-a-l subsequence, which is exactly why
    // subsequence-only matching was useless: they drowned the real hit.
    { t: 1, cwd: "/repo/a", text: "make a plan for the alpaca lot" },
    { t: 2, cwd: "/repo/a", text: "kick off a migration and roll back the last" },
    { t: 3, cwd: "/repo/a", text: "deploy the app with kamal" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  const { overlay, done } = pi.search();
  assert.equal(rows(overlay).length, 3, "everything is a match until you type");

  type(overlay, "kamal");
  assert.deepEqual(
    rows(overlay).map((line) => line.trim()),
    ["▸ deploy the app with kamal"],
    "the literal hit, and only the literal hit",
  );
  assert.equal(status(overlay), "search kamal 1/1", "no fuzzy flag when it matched literally");

  overlay.handleInput(CTRL_U);
  assert.equal(rows(overlay).length, 3, "ctrl+u clears the query");

  type(overlay, "deploy kamal");
  assert.equal(rows(overlay).length, 1, "every token has to appear, in any order");

  overlay.handleInput(ENTER);
  await done;

  assert.deepEqual(pi.editorText, ["deploy the app with kamal"]);
  assert.equal(pi.renders.length, 1, "and the editor is asked to repaint, not left blank");
});

test("a typo falls back to loose matching, and says so", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    { t: 1, cwd: "/repo/a", text: "bump the ruby version" },
    { t: 2, cwd: "/repo/a", text: "deploy the app with kamal" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  const { overlay, done } = pi.search();
  type(overlay, "kaml");

  assert.deepEqual(
    rows(overlay).map((line) => line.trim()),
    ["▸ deploy the app with kamal"],
    "nothing matches literally, so the subsequence search takes over",
  );
  assert.equal(status(overlay), "search kaml fuzzy 1/1");

  overlay.handleInput(ESCAPE);
  await done;
});

test("ctrl+r walks towards older prompts, escape leaves the editor alone", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    { t: 1, cwd: "/repo/a", text: "oldest" },
    { t: 2, cwd: "/repo/a", text: "middle" },
    { t: 3, cwd: "/repo/a", text: "newest" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  const { overlay, done } = pi.search();
  const selected = () => rows(overlay).find((line) => line.trim().startsWith("▸"))?.trim();

  assert.equal(selected(), "▸ newest", "starts on the most recent");
  overlay.handleInput(CTRL_R);
  assert.equal(selected(), "▸ middle");
  overlay.handleInput(CTRL_R);
  assert.equal(selected(), "▸ oldest");
  overlay.handleInput(UP);
  assert.equal(selected(), "▸ middle", "and back towards newer");

  overlay.handleInput(ESCAPE);
  await done;

  assert.deepEqual(pi.editorText, [], "a cancelled search does not touch the draft");
});

test("a match from another project says which one", async () => {
  const dir = newAgentDir();
  seedFile(dir, [
    { t: 1, cwd: "/Users/e/Code/github.com/e/harvestenid", text: "regenerate the fixtures" },
    { t: 2, cwd: "/repo/a", text: "regenerate the schema" },
  ]);

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  const { overlay, done } = pi.search();
  const rendered = rows(overlay).map((line) => line.trim());

  assert.equal(rendered[0], "▸ regenerate the schema", "this project carries no label");
  assert.equal(rendered[1], "regenerate the fixtures harvestenid");

  overlay.handleInput(ESCAPE);
  await done;
});

test("searching an empty history says so instead of opening", async () => {
  const dir = newAgentDir();
  const pi = await mount(dir);
  pi.presetEditor();
  pi.start();
  pi.openEditor();

  const { overlay, done } = pi.search();
  await done;

  assert.equal(overlay, undefined, "no overlay to dismiss");
  assert.deepEqual(pi.notices, ["No prompt history yet."]);
});

test("the file is trimmed instead of growing forever", async () => {
  const dir = newAgentDir();
  const filler = "y".repeat(1000);
  seedFile(
    dir,
    Array.from({ length: 1200 }, (_, i) => ({ t: i, cwd: "/repo/a", text: `${filler}${i}` })),
  );

  const pi = await mount(dir, { cwd: "/repo/a" });
  pi.presetEditor();
  pi.start();
  pi.openEditor();
  pi.submit("the write that tips it over");

  const lines = historyLines(dir);
  const bytes = readFileSync(join(dir, "prompt-history.jsonl")).length;
  assert.ok(bytes < 1024 * 1024, `trimmed to ${bytes} bytes`);
  assert.equal(lines.at(-1).text, "the write that tips it over", "newest survives");
  assert.equal(lines.at(0).text.startsWith(filler), true, "and it is whole records that remain");
});
