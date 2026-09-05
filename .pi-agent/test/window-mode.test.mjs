import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import windowMode, { preferencePath } from "../extensions/window-mode/index.ts";
import {
  CHECKPOINT_TOOL, HISTORY_TOOL, GUIDANCE, MAX_TAIL_TOKENS,
  entryText, planRollover, recall, validateState,
} from "../extensions/window-mode/runtime.ts";

const STATE = `## Goal
Implement the parser without changing its public API.
## Constraints
Keep Ruby 3.3 support. Never change the return type.
## Progress
Rejected splitting on commas: quoted commas failed. Tokenizer tests pass.
## Decisions
Use a state machine; keep the existing public adapter.
## Next
Add escaped quote tests, then run the full suite.`;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason,
  timestamp: Date.now(), provider: "test", model: "capable", api: "openai-completions", usage: ZERO });
const toolResult = (toolCallId, toolName, content, details = {}) => ({ role: "toolResult", toolCallId,
  toolName, content: [{ type: "text", text: content }], details, isError: false, timestamp: Date.now() });

function mount(sm = SessionManager.inMemory()) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notifications = [];
  let active = ["read", "bash"];
  let activeUpdates = 0;
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerTool: (tool) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => active.slice(),
    setActiveTools: (names) => { active = names.slice(); activeUpdates++; },
  };
  const ctx = {
    cwd: process.cwd(), hasUI: true, mode: "tui", model: { provider: "test", id: "capable" },
    thinkingLevel: "high", sessionManager: sm,
    ui: { notify: (message) => notifications.push(message) },
    getContextUsage: () => ({ tokens: 100_000, contextWindow: 128_000, percent: 78.125 }),
    waitForIdle: async () => {},
  };
  windowMode(pi);
  const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const command = (args) => commands.get("window-mode").handler(args, ctx);
  const prompt = () => fire("before_agent_start", { systemPrompt: "Original instructions." });
  const checkpoint = async (state = STATE, siblings = []) => {
    const callId = `checkpoint-${sm.getEntries().length}`;
    const anchor = sm.appendMessage(assistant([
      { type: "toolCall", name: CHECKPOINT_TOOL, id: callId, arguments: { state } }, ...siblings,
    ], "toolUse"));
    const result = await tools.get(CHECKPOINT_TOOL).execute(callId, { state }, undefined, undefined, ctx);
    const noteId = sm.appendMessage({ ...toolResult(callId, CHECKPOINT_TOOL, result.content[0].text, result.details) });
    return { anchor, noteId, result };
  };
  const prepare = (extra = {}) => ({
    type: "session_before_compact", branchEntries: sm.getBranch(), reason: "threshold", willRetry: false,
    signal: new AbortController().signal,
    preparation: { tokensBefore: 100_000, firstKeptEntryId: sm.getBranch()[0]?.id,
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
    ...extra,
  });
  const compact = async (extra) => {
    const result = await fire("session_before_compact", prepare(extra));
    if (result?.compaction) {
      const c = result.compaction;
      sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
      await fire("session_compact", { compactionEntry: sm.getLeafEntry(), fromExtension: true });
    }
    return result?.compaction;
  };
  return { sm, pi, ctx, tools, notifications, fire, command, prompt, checkpoint, prepare, compact,
    get activeUpdates() { return activeUpdates; } };
}

async function isolated(fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pi-window-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return await fn(dir); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function enabled(fn) {
  return isolated(async () => {
    const m = mount();
    await m.fire("session_start");
    await m.command("on");
    await m.prompt();
    return fn(m);
  });
}

test("disabled boot touches no history, creates no tools, and adds no prompt context", () => isolated(async () => {
  const m = mount();
  const leaf = m.sm.getLeafEntry.bind(m.sm);
  m.sm.getLeafEntry = () => { throw new Error("boot must not inspect history"); };
  m.sm.getBranch = () => { throw new Error("boot must not traverse history"); };
  await m.fire("session_start");
  assert.equal(m.tools.size, 0);
  assert.equal(m.activeUpdates, 0);
  m.sm.getLeafEntry = leaf;
  assert.equal(await m.prompt(), undefined);
  assert.equal(m.tools.size, 0);
}));

test("enabled boot defers implementation/tools until the first request", () => isolated(async () => {
  const a = mount();
  await a.command("on");
  const b = mount();
  b.sm.getLeafEntry = () => { throw new Error("boot must not inspect history"); };
  await b.fire("session_start");
  assert.equal(b.tools.size, 0);
  assert.equal(b.activeUpdates, 0);
}));

test("exact provider/model opt-in persists; sibling versions and other providers remain off", () => isolated(async () => {
  const m = mount();
  await m.command("on");
  assert.match((await m.prompt()).systemPrompt, /Window mode/);
  const policy = JSON.parse(await readFile(preferencePath("test/capable"), "utf8"));
  assert.deepEqual(policy, { version: 1, model: "test/capable", enabled: true });
  for (const model of [{ provider: "other", id: "capable" }, { provider: "test", id: "capable-v2" }]) {
    m.ctx.model = model;
    await m.fire("model_select");
    assert.equal(await m.prompt(), undefined);
    assert.deepEqual(m.pi.getActiveTools(), ["read", "bash"]);
    assert.equal(await m.fire("session_before_compact", m.prepare()), undefined);
  }
  m.ctx.model = { provider: "test", id: "capable" };
  await m.fire("model_select");
  assert.match((await m.prompt()).systemPrompt, /Window mode/);
  await m.command("off");
  const resumed = mount();
  await resumed.fire("session_start");
  assert.equal(await resumed.prompt(), undefined);
}));

test("corrupt, mismatched, and non-boolean preferences fail closed", () => isolated(async () => {
  const file = preferencePath("test/capable");
  await mkdir(dirname(file), { recursive: true });
  for (const raw of ["{broken", JSON.stringify({ version: 1, model: "other/capable", enabled: true }),
    JSON.stringify({ version: 1, model: "test/capable", enabled: "true" })]) {
    await writeFile(file, raw);
    const m = mount();
    await m.fire("session_start");
    assert.equal(await m.prompt(), undefined);
  }
}));

test("out-of-order model preference reads cannot opt the wrong model in", () => isolated(async () => {
  const m = mount();
  await m.command("on");
  const first = m.fire("model_select");
  m.ctx.model = { provider: "other", id: "capable" };
  const second = m.fire("model_select");
  await Promise.all([first, second]);
  assert.equal(await m.prompt(), undefined);
}));

test("checkpoint validation requires filled, ordered sections and bounded state", () => {
  validateState(STATE);
  for (const bad of ["tiny", STATE.repeat(40), STATE.replace("## Next", "## Nope"),
    STATE.replace("## Constraints\nKeep Ruby 3.3 support. Never change the return type.", "## Constraints\n"),
    STATE + "\n## Goal\nduplicate"]) assert.throws(() => validateState(bad));
});

test("rollover preserves constraints/failed attempts and every post-checkpoint message without an LLM", () => enabled(async (m) => {
  const old = m.sm.appendMessage(user("Do not change public API. Keep Ruby 3.3 support."));
  m.sm.appendMessage(assistant([{ type: "text", text: "Old deliberation".repeat(2000) }]));
  const { anchor, noteId } = await m.checkpoint();
  m.sm.appendMessage(user("Also test empty input."));
  m.sm.appendMessage(assistant([{ type: "text", text: "I will add that test next." }]));
  const c = await m.compact();
  assert.equal(c.firstKeptEntryId, anchor);
  assert.match(c.summary, /Keep Ruby 3.3 support/);
  assert.match(c.summary, /quoted commas failed/);
  assert.equal(c.details.checkpointId, noteId);
  assert.ok(c.details.tailTokens <= MAX_TAIL_TOKENS);
  assert.ok(!("usage" in c), "no summarizer usage");
  const context = m.sm.buildSessionContext().messages;
  assert.equal(context[0].role, "compactionSummary");
  assert.ok(context.some((msg) => msg.role === "user" && msg.content === "Also test empty input."));
  assert.ok(!context.some((msg) => msg.content === "Do not change public API. Keep Ruby 3.3 support."));
  assert.ok(m.sm.getBranch().some((entry) => entry.id === old), "raw history remains recoverable");
  const recovered = await recall(m.sm.getBranch(), { id: old });
  assert.match(recovered.text, /public API/);
}));

test("complete parallel tool batches stay together; incomplete ones cannot roll over", () => enabled(async (m) => {
  m.sm.appendMessage(user("Implement parser"));
  const { anchor } = await m.checkpoint(STATE, [
    { type: "toolCall", name: "bash", id: "parallel-bash", arguments: { command: "test" } },
  ]);
  assert.equal(planRollover(m.prepare()), undefined);
  m.sm.appendMessage(toolResult("parallel-bash", "bash", "A test failed after the checkpoint was written."));
  const c = await m.compact();
  assert.equal(c.firstKeptEntryId, anchor);
  const context = m.sm.buildSessionContext().messages;
  assert.ok(context.some((msg) => msg.role === "toolResult" && msg.toolCallId === "parallel-bash"));
}));

test("missing, stale, oversized, reused, or invalid checkpoint falls back instead of dropping a gap", () => enabled(async (m) => {
  m.sm.appendMessage(user("Implement parser"));
  assert.equal(await m.compact(), undefined);
  await m.checkpoint();
  const afterNote = m.sm.getLeafId();
  m.sm.appendMessage(user("Later requirements ".repeat(6000)));
  assert.equal(await m.compact(), undefined);
  m.sm.branch(afterNote);
  const c = await m.compact();
  assert.ok(c);
  m.sm.appendMessage(user("New work after rollover"));
  assert.equal(await m.compact(), undefined, "must not reuse a pre-rollover checkpoint");
}));

test("overflow, cancellation, small sessions, and custom /compact instructions use safe fallback", () => enabled(async (m) => {
  m.sm.appendMessage(user("Implement parser"));
  await m.checkpoint();
  assert.equal(await m.compact({ reason: "overflow", willRetry: true }), undefined);
  assert.equal(await m.compact({ reason: "manual", customInstructions: "Focus on security" }), undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal(await m.compact({ signal: controller.signal }), undefined);
  const e = m.prepare(); e.preparation.tokensBefore = 100;
  assert.equal(planRollover(e), undefined);
}));

test("new checkpoint supports repeated rollovers without losing earlier exact history", () => enabled(async (m) => {
  const first = m.sm.appendMessage(user("Unique requirement from window zero: support KOI8-R."));
  for (let n = 0; n < 5; n++) {
    m.sm.appendMessage(assistant([{ type: "text", text: `Window ${n} work.` }]));
    await m.checkpoint(STATE + `\nWindow ${n}: preserve KOI8-R support.`);
    assert.ok(await m.compact());
  }
  const result = await recall(m.sm.getBranch(), { id: first });
  assert.match(result.text, /KOI8-R/);
  assert.equal(m.sm.getBranch().filter((e) => e.type === "compaction").length, 5);
}));

test("branch navigation never reuses another branch's checkpoint or retrieves its messages", () => enabled(async (m) => {
  const root = m.sm.appendMessage(user("Shared task"));
  const abandoned = m.sm.appendMessage(user("Only branch A sees purple zebras."));
  await m.checkpoint();
  m.sm.branch(root);
  await m.fire("session_tree");
  m.sm.appendMessage(user("Branch B task"));
  assert.equal(await m.compact(), undefined);
  assert.deepEqual((await recall(m.sm.getBranch(), { query: "purple zebras" })).matches, []);
  await assert.rejects(recall(m.sm.getBranch(), { id: abandoned }), /active branch/);
}));

test("disk resume restores checkpoint and branch-local recovery; disabled model gets recall only", () => isolated(async (dir) => {
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  const m = mount(sm);
  await m.command("on");
  const old = sm.appendMessage(user("Original requirement from disk."));
  await m.checkpoint();
  const file = sm.getSessionFile();
  assert.ok(file);
  const b = mount(SessionManager.open(file));
  await b.fire("session_start");
  await b.prompt();
  assert.ok(await b.compact());
  const c = mount(SessionManager.open(file));
  c.ctx.model = { provider: "other", id: "unlisted" };
  await c.fire("session_start");
  assert.equal(c.tools.size, 0, "resume boot does not eagerly initialize recovery");
  assert.match((await c.prompt()).systemPrompt, /context_recall/);
  assert.deepEqual(c.pi.getActiveTools(), ["read", "bash", HISTORY_TOOL]);
  assert.equal(await c.fire("session_before_compact", c.prepare()), undefined);
  assert.match((await recall(c.sm.getBranch(), { id: old })).text, /Original requirement/);
}));

test("history search/list/read pagination is bounded, literal and active-branch scoped", async () => {
  const sm = SessionManager.inMemory();
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(sm.appendMessage(user(`record ${i}: literal [a.*] needle ` + "x".repeat(1000))));
  const first = await recall(sm.getBranch(), { query: "[a.*]" });
  assert.equal(first.matches.length, 8);
  assert.ok(first.matches.every((m) => m.snippet.length <= 240));
  const second = await recall(sm.getBranch(), { query: "[a.*]", before: first.nextBefore });
  assert.equal(second.matches.length, 8);
  assert.ok(second.matches.every((m) => !first.matches.some((previous) => previous.id === m.id)));
  const third = await recall(sm.getBranch(), { query: "[a.*]", before: second.nextBefore });
  assert.equal(third.matches.length, 4);
  assert.equal(third.nextBefore, null);
  const recent = await recall(sm.getBranch(), {});
  assert.equal(recent.matches.length, 8);
  assert.equal(recent.matches[0].id, ids[19]);
  assert.equal((await recall(sm.getBranch(), { query: "NEEDLE" })).matches.length, 0);
  const long = sm.appendMessage(user("abcd".repeat(3000)));
  let text = "", offset;
  do {
    const page = await recall(sm.getBranch(), { id: long, offset });
    assert.ok(page.text.length <= 4000);
    text += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(text, "abcd".repeat(3000));
  for (const args of [{ id: "missing" }, { before: "missing" }, { offset: 4 }, { id: long, offset: -1 },
    { id: long, query: "x" }, { query: "x".repeat(257) }]) await assert.rejects(recall(sm.getBranch(), args));
  const c = new AbortController(); c.abort();
  await assert.rejects(recall(sm.getBranch(), {}, c.signal), { name: "AbortError" });
});

test("recovery excludes thinking, image bytes, non-context shell runs, and private tool metadata", async () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(assistant([{ type: "thinking", thinking: "hidden-reasoning-marker" },
    { type: "text", text: "Visible answer" }]));
  sm.appendMessage(toolResult("tool", "read", "Visible output", { private: "hidden-details-marker" }));
  sm.appendMessage({ role: "bashExecution", command: "sensitive", output: "hidden-shell-marker",
    excludeFromContext: true, timestamp: Date.now() });
  sm.appendMessage(user([{ type: "image", data: "hidden-image-marker", mimeType: "image/png" }]));
  sm.appendCustomEntry("internal", { text: "hidden-custom-marker" });
  for (const term of ["hidden-reasoning", "hidden-details", "hidden-shell", "hidden-image", "hidden-custom"]) {
    assert.deepEqual((await recall(sm.getBranch(), { query: term })).matches, []);
  }
  assert.equal((await recall(sm.getBranch(), { query: "Visible" })).matches.length, 2);
  assert.equal(entryText(sm.getLeafEntry()), undefined);
});

test("budget reminders are sparse suffixes; normal requests do not read history or rebuild tools", () => enabled(async (m) => {
  let tokens = 100_000;
  m.ctx.getContextUsage = () => ({ tokens, contextWindow: 128_000 });
  const event = { messages: [user("Continue task")] };
  assert.equal(await m.fire("context", event), undefined);
  tokens = 105_000;
  const reminder = await m.fire("context", event);
  assert.equal(reminder.messages.length, 2);
  assert.match(reminder.messages[1].content, /Save\/update context_checkpoint/);
  assert.equal(event.messages.length, 1, "non-destructive");
  assert.equal(await m.fire("context", event), undefined);
  m.sm.appendMessage(user("Implement parser"));
  await m.checkpoint();
  tokens += 1000;
  assert.equal(await m.fire("context", event), undefined);
  tokens += 2000;
  assert.ok(await m.fire("context", event));
  await m.fire("session_compact_failed");
  assert.ok(await m.fire("context", event));
  m.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 128_000 });
  assert.equal(await m.fire("context", event), undefined);
  const previousUpdates = m.activeUpdates;
  m.sm.getBranch = () => { throw new Error("routine requests must not scan history"); };
  m.sm.getLeafEntry = () => { throw new Error("routine requests must not scan history"); };
  assert.equal((await m.prompt()).systemPrompt, `Original instructions.\n\n${GUIDANCE}`);
  assert.equal(m.activeUpdates, previousUpdates);
}));

test("disabled checkpoint execution and missing source messages fail instead of inventing anchors", () => enabled(async (m) => {
  await assert.rejects(m.tools.get(CHECKPOINT_TOOL).execute("not-persisted", { state: STATE }, undefined, undefined, m.ctx), /not persisted/);
  await m.command("off");
  await assert.rejects(m.tools.get(CHECKPOINT_TOOL).execute("off", { state: STATE }, undefined, undefined, m.ctx), /not enabled/);
}));

test("status counts completed rollovers and fallbacks, not cancelled attempts", () => enabled(async (m) => {
  await m.command("status");
  assert.match(m.notifications.at(-1), /0 checkpoint rollovers, 0 completed fallbacks/);
  m.sm.appendMessage(user("Implement parser"));
  await m.checkpoint();
  assert.ok(await m.compact());
  await m.command("status");
  assert.match(m.notifications.at(-1), /1 checkpoint rollovers, 0 completed fallbacks/);
  m.sm.appendMessage(user("Continue after rollover"));
  const missed = await m.fire("session_before_compact", m.prepare());
  assert.equal(missed, undefined);
  m.sm.appendCompaction("ordinary summary", m.sm.getLeafId(), 100_000, {}, false);
  await m.fire("session_compact", { compactionEntry: m.sm.getLeafEntry() });
  await m.command("status");
  assert.match(m.notifications.at(-1), /1 checkpoint rollovers, 1 completed fallbacks/);
  await m.checkpoint();
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await m.compact({ signal: cancelled.signal }), undefined);
  await m.fire("session_compact_failed", { aborted: true });
  await m.command("status");
  assert.match(m.notifications.at(-1), /1 checkpoint rollovers, 1 completed fallbacks/);
}));

test("initial prompt + two schemas stay within the 500-token heuristic budget", () => enabled(async (m) => {
  // Track the actual serialized public definitions; provider tokenizers differ.
  const schemaText = JSON.stringify([...m.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })));
  const approximateTokens = Math.ceil((GUIDANCE.length + schemaText.length) / 4);
  assert.ok(approximateTokens <= 500, `approximate initial overhead: ${approximateTokens} tokens`);
}));
