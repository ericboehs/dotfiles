/**
 * Smoke tests for /1 /2 /3.
 *
 * The parser is the part that rots: it reads Markdown a model wrote, so the
 * cases below are real reply shapes (hard-wrapped continuations, a bolded
 * heading, a list with no heading at all) rather than tidy fixtures. The mount
 * tests cover the two things a wrong answer is expensive for — expanding a step
 * that was not asked for, and sending "/9" to the model as text.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import nextSteps, {
  buildPrompt,
  completionItems,
  parseNextSteps,
  resolveSelection,
} from "../extensions/next-steps.ts";

const REPLY = `Checked the switch logs and the Pi's own counters.

Next steps:
 1. Add flap-detection monitoring — a command_line sensor on
    /sys/class/net/end0/carrier_changes plus an alert above ~5/hr.
    Highest value regardless of root cause: turns a silent 4-hour
    blackout into an early warning. I can write the YAML now.
 2. Pull UniFi port stats for the HA switch port to settle
    cable-vs-Pi-PHY definitively, before yesterday's flap history ages
    out of the controller.
 3. Append the IPv6 link-local SSH gotcha to core.md (ssh -4, or pin
    10.0.1.113 in ~/.ssh/config) so future sessions don't burn 3 minutes
    per hung command.

Which one do you want?`;

const STEPS = parseNextSteps(REPLY);

async function mount(replies = [REPLY]) {
  const url = new URL("../extensions/next-steps.ts", import.meta.url);
  url.search = `?t=${Math.random()}`;
  const extension = (await import(url.href)).default;

  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler) });

  const notices = [];
  const editor = { text: "" };
  let provider;
  const branch = [{ type: "message", id: "u0", message: { role: "user", content: [] } }];
  // Oldest first, the order getBranch() returns.
  replies.forEach((text, i) => {
    branch.push({
      type: "message",
      id: `a${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  });

  // Stands in for pi's built-in provider: enough to prove delegation happened.
  const builtIn = {
    getSuggestions: async () => ({ prefix: "/", items: [{ value: "model", label: "model" }] }),
    applyCompletion: () => ({ lines: ["delegated"], cursorLine: 0, cursorCol: 9 }),
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setEditorText: (text) => {
        editor.text = text;
      },
      addAutocompleteProvider: (factory) => {
        provider = factory(builtIn);
      },
    },
    sessionManager: { getBranch: () => branch },
  };

  handlers.get("session_start")({}, ctx);

  return {
    notices,
    editor,
    submit: (text, source = "interactive") => handlers.get("input")({ text, source }, ctx),
    suggest: (line, options = {}) => provider.getSuggestions([line], 0, line.length, options),
    complete: (line, value) =>
      provider.applyCompletion([line], 0, line.length, { value, label: value }, value),
  };
}

test("a hard-wrapped numbered block becomes one unwrapped step each", () => {
  assert.equal(STEPS.length, 3);
  assert.match(STEPS[0], /^Add flap-detection monitoring — a command_line sensor on \/sys\/class/);
  assert.match(STEPS[0], /I can write the YAML now\.$/, "continuation lines joined, not dropped");
  assert.match(STEPS[2], /per hung command\.$/);
  assert.ok(
    STEPS.every((step) => !step.includes("\n")),
    "each step is one line, so the sent message reads as a sentence",
  );
});

test("the trailing question is not swallowed into the last step", () => {
  assert.ok(!STEPS[2].includes("Which one do you want?"));
});

test("a bolded heading and inline Markdown survive", () => {
  const steps = parseNextSteps(`**Next steps:**\n1. **Ship it** — merge #12\n2. Roll back`);
  assert.deepEqual(steps, ["**Ship it** — merge #12", "Roll back"]);
});

test("an unheaded reply falls back to its last numbered list", () => {
  const steps = parseNextSteps(
    ["Two things went wrong:", "1. dns", "2. dhcp", "", "So:", "1. pin the lease", "2. restart"].join("\n"),
  );
  assert.deepEqual(steps, ["pin the lease", "restart"], "the earlier findings list is not the menu");
});

test("a reply with no list at all parses to nothing", () => {
  assert.deepEqual(parseNextSteps("Yes, that is the right port."), []);
});

test("digits map left to right, de-duplicated", () => {
  assert.deepEqual(resolveSelection("2", 3), [2]);
  assert.deepEqual(resolveSelection("13", 3), [1, 3]);
  assert.deepEqual(resolveSelection("31", 3), [3, 1], "order is what was typed");
  assert.deepEqual(resolveSelection("11", 3), [1]);
  assert.equal(resolveSelection("4", 3), null);
  assert.equal(resolveSelection("0", 3), null);
  assert.deepEqual(resolveSelection("12", 12), [12], "ten or more steps reads one number");
});

test("two picks are joined with a capital AND", () => {
  const prompt = buildPrompt(["alpha", "beta", "gamma"], [1, 3]);
  assert.equal(prompt, "alpha\n\nAND\n\ngamma");
});

test("anything typed after the digits is appended as its own instruction", () => {
  assert.equal(buildPrompt(["alpha", "beta"], [2], "  but on the pi  "), "beta\n\nbut on the pi");
});

test("the exact typed selection is the first completion", () => {
  const items = completionItems(["alpha", "beta", "gamma"], "13");
  assert.equal(items[0].value, "13", "Enter applies item 0 — it must be what was typed");
  assert.match(items[0].description, /^alpha AND gamma$/);
  assert.deepEqual(
    items.slice(1).map((i) => i.value),
    ["132"],
    "only steps not already picked are offered",
  );
});

test("a selection that cannot resolve offers nothing", () => {
  assert.deepEqual(completionItems(["alpha", "beta"], "9"), []);
});

test("a bare slash lists every step", () => {
  assert.deepEqual(
    completionItems(["alpha", "beta", "gamma"], "").map((i) => i.value),
    ["1", "2", "3"],
  );
});

test("/13 expands both steps into the editor instead of sending", async () => {
  const pi = await mount();
  const result = await pi.submit("/13");

  assert.equal(result.action, "handled", "nothing reaches the model");
  assert.equal(pi.editor.text, `${STEPS[0]}\n\nAND\n\n${STEPS[2]}`);
  assert.deepEqual(pi.notices, []);
});

test("the trailing space autocomplete inserts is not an argument", async () => {
  const pi = await mount();
  await pi.submit("/2 ");
  assert.equal(pi.editor.text, STEPS[1]);
});

test("an out-of-range step is swallowed, not sent to the model", async () => {
  const pi = await mount();
  const result = await pi.submit("/9");

  assert.equal(result.action, "handled");
  assert.equal(pi.editor.text, "", "the editor is left alone");
  assert.match(pi.notices[0].message, /offered 3 next steps/);
  assert.equal(pi.notices[0].level, "warning");
});

test("ordinary prompts and injected messages pass straight through", async () => {
  const pi = await mount();
  assert.equal(await pi.submit("what is /1 in bash"), undefined);
  assert.equal(await pi.submit("/model"), undefined);
  assert.equal(await pi.submit("/1", "extension"), undefined);
});

test("a short reply in between reaches back, and says so", async () => {
  const pi = await mount([REPLY, "Yes, that is the right port."]);
  await pi.submit("/2");

  assert.equal(pi.editor.text, STEPS[1]);
  assert.match(pi.notices[0].message, /2 replies back/);
});

test("no numbered steps anywhere means nothing is sent", async () => {
  const pi = await mount(["Yes.", "Still yes."]);
  const result = await pi.submit("/1");

  assert.equal(result.action, "handled");
  assert.equal(pi.editor.text, "");
  assert.match(pi.notices[0].message, /no numbered next steps/);
});

test("the completion reports a slash-less prefix, so Enter expands instead of sending", async () => {
  const pi = await mount();
  const suggestions = await pi.suggest("/13");

  assert.equal(suggestions.prefix, "13");
  assert.equal(suggestions.items[0].value, "13");
});

test("applying a completion rewrites the line with the step itself", async () => {
  const pi = await mount();
  const result = pi.complete("/13", "13");

  assert.deepEqual(result.lines, `${STEPS[0]}\n\nAND\n\n${STEPS[2]}`.split("\n"));
  assert.equal(result.cursorLine, result.lines.length - 1);
  assert.equal(result.cursorCol, result.lines[result.lines.length - 1].length);
});

test("a bare slash keeps pi's own commands, and its own completion behaviour", async () => {
  const pi = await mount();
  const suggestions = await pi.suggest("/");

  assert.equal(suggestions.prefix, "/", "pi's prefix survives, so Enter still runs a command");
  assert.deepEqual(
    suggestions.items.map((i) => i.value),
    ["model", "1", "2", "3"],
    "steps are appended, never ahead of a real command",
  );
  assert.deepEqual(pi.complete("/model", "model").lines, ["delegated"]);
});

test("tab at a bare slash is still pi's filesystem gesture", async () => {
  const pi = await mount();
  const suggestions = await pi.suggest("/", { force: true });
  assert.deepEqual(
    suggestions.items.map((i) => i.value),
    ["model"],
  );
});

test("a line that is not an invocation is left to pi", async () => {
  const pi = await mount();
  assert.deepEqual((await pi.suggest("/mod")).items.map((i) => i.value), ["model"]);
  assert.deepEqual(pi.complete("/1", "model").lines, ["delegated"]);
});
