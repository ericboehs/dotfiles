/**
 * Smoke tests for the deferred `subagent` tool.
 *
 * Nothing here spawns a real child pi: validation errors return before any
 * spawn, and background mode hands its command to a fake bg.ts listener. The
 * one subprocess is bash running the generated progress filter on a recorded
 * JSONL shape, which is the part that rots: it is shell-quoted node source.
 *
 *   bin/pi-ext-check                 # typecheck + all tests
 *   node --test .pi-agent/test/subagent.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Hermetic agent discovery: no user agents/*.md, so only the built-ins exist.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-agent-subagent-test-"));
delete process.env.PI_SUBAGENT_CHILD;

const { default: subagent } = await import("../extensions/subagent.ts");

function mount({ active = ["read", "bash"], registered = ["read", "bash", "tool_search"] } = {}) {
  const handlers = new Map();
  let tool;
  let bgListener;
  const state = { active: [...active] };
  subagent({
    registerTool: (definition) => (tool = definition),
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => state.active,
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveTools: (names) => (state.active = names),
    events: { on: () => () => {}, emit: (channel, data) => channel === "bg:start" && bgListener?.(data) },
  });
  const ctx = { cwd: mkdtempSync(path.join(tmpdir(), "pi-subagent-cwd-")), model: undefined };
  return {
    tool,
    state,
    start: () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx),
    run: (params) => tool.execute("test-call", params, undefined, undefined, ctx),
    onBgStart: (listener) => (bgListener = listener),
    ctx,
  };
}

const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("registers deferred, so it costs nothing until tool_search finds it", () => {
  const { tool } = mount();
  assert.equal(tool.name, "subagent");
  assert.equal(tool.exposure, "deferred");
  assert.ok(tool.parameters.properties.background, "background option is declared");
});

test("session_start activates tool_search, without which a deferred tool is unreachable", () => {
  const h = mount();
  h.start();
  assert.deepEqual(h.state.active, ["read", "bash", "tool_search"]);
});

test("session_start leaves tools alone when tool_search is active or not registered", () => {
  const already = mount({ active: ["read", "tool_search"] });
  already.start();
  assert.deepEqual(already.state.active, ["read", "tool_search"]);

  const excluded = mount({ registered: ["read", "bash"] }); // e.g. --tools without it
  excluded.start();
  assert.deepEqual(excluded.state.active, ["read", "bash"]);
});

test("child subagents skip tool_search so they stay lean and cannot recurse", (t) => {
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => delete process.env.PI_SUBAGENT_CHILD);
  const h = mount();
  h.start();
  assert.deepEqual(h.state.active, ["read", "bash"]);
});

test("rejects bad shapes before spawning anything", async () => {
  const { run } = mount();
  assert.match(textOf(await run({})), /Pass single \{agent, task\}.*Agents: scout, worker/);
  assert.match(textOf(await run({ agent: "nope", task: "hi" })), /Unknown agent "nope"/);
  const nine = Array.from({ length: 9 }, (_, i) => ({ agent: "scout", task: `t${i}` }));
  assert.match(textOf(await run({ tasks: nine })), /\(1-8\)/);
});

test("background without bg.ts says so instead of hanging", async () => {
  const { run } = mount();
  assert.match(textOf(await run({ agent: "scout", task: "hi", background: true })), /needs the bg\.ts extension/);
});

test("background hands a quoted child command and its labels to bg.ts", async () => {
  const h = mount();
  let req;
  h.onBgStart((r) => {
    r.accepted = true;
    req = r;
    queueMicrotask(() => r.reply({ id: "abc123", logPath: "/tmp/pi-bg-test/abc123.log" }));
  });
  const result = await h.run({ agent: "scout", task: "it's a 'quoted' task", background: true });

  assert.match(textOf(result), /\[scout\] bg abc123 · log \/tmp\/pi-bg-test\/abc123\.log/);
  assert.equal(req.name, "sa:scout");
  assert.equal(req.summary, "subagent scout: it's a 'quoted' task");
  assert.equal(req.cwd, h.ctx.cwd);
  assert.ok(req.tailLines >= 100, "the wake carries the whole report, not bg's default 15 lines");
  assert.ok(req.command.startsWith("PI_SUBAGENT_CHILD=1 "));
  assert.ok(req.command.includes("Task: it'\\''s a '\\''quoted'\\'' task"), "single quotes survive the shell");
  assert.match(req.command, /You are a subagent\. Your final message goes to another AI agent/);
});

test("the progress filter prints a line per turn, a usage banner, then the answer", async () => {
  const h = mount();
  let command;
  h.onBgStart((r) => {
    r.accepted = true;
    command = r.command;
    r.reply({ id: "abc123", logPath: "/tmp/x.log" });
  });
  await h.run({ agent: "scout", task: "count", background: true });

  // The filter half of `<child> | '<node>' -e '<filter>'`. Split on the node
  // path, not " | ": the filter source itself contains " | ".
  const filter = command.slice(command.indexOf(` | '${process.execPath}' -e `) + 3);
  const turn = (content, usage) => JSON.stringify({ type: "message_end", message: { role: "assistant", content, usage } });
  const jsonl = [
    JSON.stringify({ type: "session" }),
    turn([{ type: "toolCall", name: "bash", arguments: { command: "ls pi-extensions" } }], {
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0004 },
    }),
    "not json",
    turn([{ type: "text", text: "4 files" }], {
      input: 200, output: 30, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.0006 },
    }),
  ].join("\n");
  const out = execFileSync("bash", ["-c", filter], { input: jsonl, encoding: "utf8" });

  assert.equal(
    out,
    [
      "· turn 1 · bash ls pi-extensions",
      "· turn 2 · 4 files",
      "── result · 2 turns · 1.3k in (1.0k cached) / 50 out · $0.0010 ──",
      "4 files",
      "",
    ].join("\n"),
  );
});

test("the progress filter exits non-zero when the child produced no answer", async () => {
  const h = mount();
  let command;
  h.onBgStart((r) => {
    r.accepted = true;
    command = r.command;
    r.reply({ id: "abc123", logPath: "/tmp/x.log" });
  });
  await h.run({ agent: "scout", task: "count", background: true });
  const filter = command.slice(command.indexOf(` | '${process.execPath}' -e `) + 3);
  assert.throws(
    () => execFileSync("bash", ["-c", filter], { input: "", encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 1 && /\(no output\)/.test(error.stdout),
  );
});
