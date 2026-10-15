import assert from "node:assert/strict";
import { mock, test } from "node:test";

import compaction from "../extensions/compaction/index.ts";
import {
  buildReplayPayload,
  cacheIsWarm,
  cacheTtlMs,
  clockLabel,
  contextIsLarge,
  idleCompactEnabled,
  idleDelayMs,
  idleStatus,
  isSessionPayload,
  MIN_SUMMARY_ROOM,
  minPercent,
  minTokens,
  replayTail,
  summaryRoom,
} from "../extensions/compaction/replay.ts";
import { summarizeWithoutThinking } from "../extensions/compaction/thoughtless.ts";

const OPUS = {
  provider: "github-copilot",
  id: "claude-opus-5.5",
  api: "anthropic-messages",
  contextWindow: 200_000,
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
};

const SUMMARY = "## Goal\nKeep working";

function preparation(overrides = {}) {
  return {
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
    turnPrefixMessages: [],
    previousSummary: undefined,
    tokensBefore: 100_000,
    firstKeptEntryId: "keep-from-here",
    fileOps: { read: new Set(["a.ts", "b.ts"]), edited: new Set(["b.ts"]), written: new Set() },
    ...overrides,
  };
}

function sessionPayload() {
  return {
    model: "claude-opus-5.5",
    max_tokens: 128_000,
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: [{ name: "read" }],
    messages: [{ role: "user", content: [{ type: "text", text: "do it", cache_control: { type: "ephemeral" } }] }],
  };
}

const reply = (text, stopReason = "stop") => ({
  id: "reply",
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() },
});

// ---- thoughtless.ts (moved from thoughtless-compaction.ts) ----------------

function thoughtlessFixture(model) {
  const calls = [];
  const ctx = {
    model,
    modelRegistry: {
      async complete(...args) {
        calls.push(args);
        return { stopReason: "stop", content: [{ type: "text", text: SUMMARY }], usage: { input: 10, output: 5 } };
      },
    },
    ui: { notify() {} },
  };
  const event = { preparation: preparation({ tokensBefore: 190_000 }), signal: new AbortController().signal };
  return { calls, ctx, event };
}

test("thoughtless: Opus 5.5 compacts with low-effort adaptive thinking", async () => {
  const fixture = thoughtlessFixture(OPUS);
  const result = await summarizeWithoutThinking(fixture.event, fixture.ctx);

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][2].thinkingEnabled, true);
  assert.equal(fixture.calls[0][2].effort, "low");
  assert.equal(fixture.calls[0][2].maxTokens, 64_000);
  assert.equal(result.compaction.firstKeptEntryId, "keep-from-here");
  assert.equal(result.compaction.tokensBefore, 190_000);
  assert.deepEqual(result.compaction.details, { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
});

test("thoughtless: adaptive models that permit it compact with thinking disabled", async () => {
  const fixture = thoughtlessFixture({ id: "claude-opus-4.8", api: "anthropic-messages", thinkingLevelMap: { xhigh: "xhigh" } });
  await summarizeWithoutThinking(fixture.event, fixture.ctx);

  assert.equal(fixture.calls[0][2].thinkingEnabled, false);
  assert.equal(fixture.calls[0][2].effort, undefined);
});

test("thoughtless: models that cannot disable thinking fall back to Pi compaction", async () => {
  const fixture = thoughtlessFixture({ id: "claude-fable-5", api: "anthropic-messages", thinkingLevelMap: { off: null } });
  assert.equal(await summarizeWithoutThinking(fixture.event, fixture.ctx), undefined);
  assert.equal(fixture.calls.length, 0);
});

// ---- replay.ts helpers ---------------------------------------------------

test("isSessionPayload wants messages and tools", () => {
  assert.equal(isSessionPayload(sessionPayload()), true);
  assert.equal(isSessionPayload({ ...sessionPayload(), tools: [] }), false, "summaries carry no tools");
  assert.equal(isSessionPayload({ tools: [{}] }), false);
  assert.equal(isSessionPayload(null), false);
});

test("replayTail takes only the model's own turns since the capture", () => {
  const captured = { leafId: "prompt" };
  const toolCall = { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" } };
  const toolResult = { id: "t1", type: "message", message: { role: "toolResult", content: [] } };
  const before = [{ id: "old", type: "message", message: { role: "user" } }, { id: "prompt", type: "message", message: { role: "user" } }];

  assert.deepEqual(replayTail([...before, reply("done")], captured), [reply("done").message]);
  assert.deepEqual(replayTail([...before, toolCall, toolResult], captured), [toolCall.message, toolResult.message]);
  assert.equal(replayTail([...before, toolResult], captured), undefined, "no assistant turn");
  assert.deepEqual(
    replayTail([...before, reply("done"), { id: "u", type: "usage" }, { id: "l", type: "label" }], captured),
    [reply("done").message],
    "invisible entries may trail",
  );
  assert.equal(replayTail([...before, reply("done"), { id: "q", type: "message", message: { role: "user" } }], captured), undefined);
  assert.equal(replayTail([...before, reply("done"), { id: "e", type: "context_edit" }], captured), undefined);
  assert.equal(replayTail([...before, reply("oops", "error")], captured), undefined);
  assert.equal(replayTail([...before, reply("done")], { leafId: "missing" }), undefined);
  assert.equal(replayTail([...before, reply("done")], { leafId: null }), undefined);
});

test("buildReplayPayload appends one user turn and leaves the prefix alone", () => {
  const captured = { payload: sessionPayload() };
  const original = JSON.stringify(captured.payload);
  const payload = buildReplayPayload(captured, "[Assistant]: done", "Summarize.", 50_000);

  assert.equal(JSON.stringify(captured.payload), original, "the capture is not mutated");
  assert.deepEqual(payload.messages.slice(0, -1), captured.payload.messages);
  assert.deepEqual(payload.system, captured.payload.system);
  assert.deepEqual(payload.tools, captured.payload.tools);
  assert.deepEqual(payload.messages.at(-1), {
    role: "user",
    content: [{ type: "text", text: "<latest-turns>\n[Assistant]: done\n</latest-turns>\n\nSummarize." }],
  });
  assert.equal(payload.max_tokens, 50_000);
  assert.equal(buildReplayPayload(captured, "", "S", 500_000).max_tokens, 128_000, "never raised");
  assert.equal(buildReplayPayload(captured, "", "S").messages.at(-1).content[0].text, "S");
});

test("summaryRoom refuses a cramped window", () => {
  assert.equal(summaryRoom(200_000, 100_000), 98_976);
  assert.equal(summaryRoom(200_000, 184_000), undefined, "Earl at the 200K threshold");
  assert.equal(summaryRoom(200_000, 200_000 - MIN_SUMMARY_ROOM - 1_024), MIN_SUMMARY_ROOM);
});

test("cache lifetime follows PI_CACHE_RETENTION", () => {
  assert.equal(cacheTtlMs({ PI_CACHE_RETENTION: "long" }), 3_600_000);
  assert.equal(cacheTtlMs({}), 300_000);
  const captured = { at: 0 };
  assert.equal(cacheIsWarm(captured, 3_500_000, 3_600_000), true);
  assert.equal(cacheIsWarm(captured, 3_580_000, 3_600_000), false, "30s margin");
});

test("idle compaction fires 54 minutes after the request", () => {
  assert.equal(idleDelayMs({ at: 1_000 }, 1_000, 3_600_000), 54 * 60_000);
  assert.equal(idleDelayMs({ at: 0 }, 55 * 60_000, 3_600_000), undefined, "already too late");
});

test("clockLabel is footer-sized", () => {
  assert.equal(clockLabel(new Date(2026, 9, 14, 22, 54)), "10:54p");
  assert.equal(clockLabel(new Date(2026, 9, 14, 9, 5)), "9:05a");
  assert.equal(clockLabel(new Date(2026, 9, 14, 0, 0)), "12:00a");
  assert.equal(clockLabel(new Date(2026, 9, 14, 12, 30)), "12:30p");
});

test("idle compaction settings", () => {
  assert.equal(idleCompactEnabled({ PI_CACHE_RETENTION: "long" }), true);
  assert.equal(idleCompactEnabled({ PI_CACHE_RETENTION: "long", PI_IDLE_COMPACT: "0" }), false);
  assert.equal(idleCompactEnabled({}), false, "5-minute cache: compacting after 4 idle minutes would be silly");
  assert.equal(minPercent({}), 50);
  assert.equal(minPercent({ PI_IDLE_COMPACT_MIN_PERCENT: "30" }), 30);
  assert.equal(minPercent({ PI_IDLE_COMPACT_MIN_PERCENT: "0" }), 50);
  assert.equal(contextIsLarge({ tokens: 100_000, contextWindow: 200_000 }, 50), true);
  assert.equal(contextIsLarge({ tokens: 99_999, contextWindow: 200_000 }, 50), false);
  assert.equal(contextIsLarge({ tokens: null, contextWindow: 200_000 }, 50), false);
  assert.equal(contextIsLarge(undefined, 50), false);
  assert.equal(minTokens({}), 200_000);
  assert.equal(minTokens({ PI_IDLE_COMPACT_MIN_TOKENS: "150000" }), 150_000);
  assert.equal(minTokens({ PI_IDLE_COMPACT_MIN_TOKENS: "0" }), 200_000);
  // 1M window: the token floor applies, not half the window (500K).
  assert.equal(contextIsLarge({ tokens: 200_000, contextWindow: 1_000_000 }, 50, 200_000), true);
  assert.equal(contextIsLarge({ tokens: 199_999, contextWindow: 1_000_000 }, 50, 200_000), false);
  // 200K-256K windows compact before 200K, so half the window applies.
  assert.equal(contextIsLarge({ tokens: 100_000, contextWindow: 200_000 }, 50, 200_000), true);
  assert.equal(contextIsLarge({ tokens: 128_000, contextWindow: 256_000 }, 50, 200_000), true);
  assert.equal(contextIsLarge({ tokens: 127_999, contextWindow: 256_000 }, 50, 200_000), false);
});

// ---- the extension -------------------------------------------------------

function extension({ model = OPUS, usage = { tokens: 120_000, contextWindow: 200_000 } } = {}) {
  const handlers = {};
  const commands = {};
  compaction({ on: (event, handler) => (handlers[event] = handler), registerCommand: (name, command) => (commands[name] = command) });
  const calls = { complete: [], compact: 0, notify: [], status: [] };
  const ctx = {
    model,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => usage,
    compact: () => calls.compact++,
    sessionManager: { getLeafId: () => "prompt", getSessionId: () => "session" },
    ui: { notify: (message) => calls.notify.push(message), setStatus: (key, text) => calls.status.push([key, text]) },
    modelRegistry: {
      async complete(...args) {
        calls.complete.push(args);
        return { stopReason: "stop", content: [{ type: "text", text: `Sure.\n\n${SUMMARY}` }], usage: { cacheRead: 99_000 } };
      },
    },
  };
  const compactEvent = (overrides = {}) => ({
    preparation: preparation(),
    branchEntries: [{ id: "prompt", type: "message", message: { role: "user" } }, reply("done")],
    reason: "manual",
    signal: new AbortController().signal,
    ...overrides,
  });
  return { handlers, commands, calls, ctx, compactEvent };
}

test("/idle explains the first condition that keeps the timer off", () => {
  const long = { PI_CACHE_RETENTION: "long" };
  const big = { tokens: 219_000, contextWindow: 1_000_000 };
  const captured = { at: 0 };
  const status = (o) => idleStatus({ env: long, api: "anthropic-messages", usage: big, captured, firesAt: undefined, now: 60_000, ...o });
  assert.match(status({ env: {} }), /^Off: PI_CACHE_RETENTION is not long/);
  assert.match(status({ env: { ...long, PI_IDLE_COMPACT: "0" } }), /^Off: PI_IDLE_COMPACT=0/);
  assert.match(status({ api: "openai-responses" }), /^Not armed: this model uses openai-responses API/);
  assert.match(status({ captured: undefined }), /^Not armed: no request since this session started or reloaded/);
  assert.match(status({ usage: { tokens: 150_000, contextWindow: 1_000_000 } }), /^Not armed: context is below the 200k threshold\.\ncontext 150k, threshold 200k/);
  assert.match(status({ now: 55 * 60_000 }), /^Not armed: too close to the cache expiring/);
  assert.match(status({}), /^Not armed yet: it arms when the current turn finishes/);
  assert.match(status({ firesAt: 54 * 60_000 }), /^Armed: compacts at .* \(in 53m\) unless you type first\.\ncontext 219k, threshold 200k; last request .*, cache warm until /);
});

test("/idle reports the armed timer", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.PI_CACHE_RETENTION = "long";
  delete process.env.PI_IDLE_COMPACT;
  delete process.env.PI_IDLE_COMPACT_DELAY_MS;
  delete process.env.PI_IDLE_COMPACT_MIN_PERCENT;
  delete process.env.PI_IDLE_COMPACT_MIN_TOKENS;
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());

  const { handlers, commands, calls, ctx } = extension();
  commands.idle.handler("", ctx);
  assert.match(calls.notify.at(-1), /no request since this session started or reloaded/);
  handlers.before_provider_request({ payload: sessionPayload() }, ctx);
  handlers.agent_settled({}, ctx);
  commands.idle.handler("", ctx);
  assert.match(calls.notify.at(-1), /^Armed: compacts at .* \(in 54m\)/);
  handlers.input({}, ctx);
  commands.idle.handler("", ctx);
  assert.match(calls.notify.at(-1), /^Not armed yet/, "input cancelled the timer");
});

test("compaction replays the captured request", async () => {
  const { handlers, calls, ctx, compactEvent } = extension();
  handlers.before_provider_request({ payload: sessionPayload() }, ctx);
  const result = await handlers.session_before_compact(compactEvent(), ctx);

  assert.equal(calls.complete.length, 1, "one summary call, no fallback");
  const options = calls.complete[0][2];
  const payload = options.onPayload();
  assert.equal(payload.messages.length, 2);
  assert.match(payload.messages[1].content[0].text, /^<latest-turns>\n\[Assistant\]: done\n<\/latest-turns>/);
  assert.equal(options.sessionId, "session");
  assert.equal(result.compaction.summary.split("\n<read-files>")[0].trim(), SUMMARY, "preamble dropped");
  assert.match(result.compaction.summary, /<modified-files>\nb\.ts\n<\/modified-files>/);
  assert.equal(result.compaction.details.cacheReplay, true);
  assert.equal(result.compaction.usage.cacheRead, 99_000);
});

test("compaction falls back to the thoughtless summary when the replay cannot hit the cache", async (t) => {
  const cases = {
    "no capture": (h, ctx) => h.session_before_compact,
    "another model": (h, ctx) => {
      h.before_provider_request({ payload: sessionPayload() }, { ...ctx, model: { ...OPUS, id: "claude-haiku-5.5" } });
    },
    "a summary payload, not a session one": (h, ctx) => {
      h.before_provider_request({ payload: { ...sessionPayload(), tools: [] } }, ctx);
    },
  };
  for (const [name, setup] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { handlers, calls, ctx, compactEvent } = extension();
      setup(handlers, ctx);
      const result = await handlers.session_before_compact(compactEvent(), ctx);
      assert.equal(calls.complete.length, 1);
      assert.equal(calls.complete[0][1].systemPrompt.startsWith("You are a context summarization assistant"), true);
      assert.equal(result.compaction.details.cacheReplay, undefined);
    });
  }

  await t.test("overflow recovery", async () => {
    const { handlers, calls, ctx, compactEvent } = extension();
    handlers.before_provider_request({ payload: sessionPayload() }, ctx);
    await handlers.session_before_compact(compactEvent({ reason: "overflow" }), ctx);
    assert.equal(calls.complete[0][2].onPayload, undefined);
  });

  await t.test("too little room in the window", async () => {
    const { handlers, calls, ctx, compactEvent } = extension();
    handlers.before_provider_request({ payload: sessionPayload() }, ctx);
    await handlers.session_before_compact(compactEvent({ preparation: preparation({ tokensBefore: 184_000 }) }), ctx);
    assert.equal(calls.complete[0][2].onPayload, undefined);
  });

  await t.test("the replay returns no summary", async () => {
    const { handlers, calls, ctx, compactEvent } = extension();
    const complete = ctx.modelRegistry.complete;
    ctx.modelRegistry.complete = async (...args) =>
      args[2].onPayload ? (calls.complete.push(args), { stopReason: "toolUse", content: [] }) : complete(...args);
    handlers.before_provider_request({ payload: sessionPayload() }, ctx);
    const result = await handlers.session_before_compact(compactEvent(), ctx);
    assert.equal(calls.complete.length, 2, "replay, then thoughtless");
    assert.equal(result.compaction.details.cacheReplay, undefined);
  });
});

test("a finished compaction drops the capture", async () => {
  const { handlers, calls, ctx, compactEvent } = extension();
  handlers.before_provider_request({ payload: sessionPayload() }, ctx);
  handlers.session_compact({}, ctx);
  await handlers.session_before_compact(compactEvent(), ctx);
  assert.equal(calls.complete[0][2].onPayload, undefined);
});

test("idle timer compacts 54 minutes after the last request, and input cancels it", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.PI_CACHE_RETENTION = "long";
  delete process.env.PI_IDLE_COMPACT;
  delete process.env.PI_IDLE_COMPACT_DELAY_MS;
  delete process.env.PI_IDLE_COMPACT_MIN_PERCENT;
  delete process.env.PI_IDLE_COMPACT_MIN_TOKENS;
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());

  const { handlers, calls, ctx } = extension();
  handlers.before_provider_request({ payload: sessionPayload() }, ctx);
  handlers.agent_settled({}, ctx);
  assert.deepEqual(calls.status.at(-1), ["idle-compact", `⏲${clockLabel(new Date(54 * 60_000))}`], "footer chip shows the fire time");
  mock.timers.tick(54 * 60_000 - 1);
  assert.equal(calls.compact, 0);
  mock.timers.tick(1);
  assert.equal(calls.compact, 1);
  assert.deepEqual(calls.status.at(-1), ["idle-compact", undefined], "chip cleared when it fires");

  handlers.before_provider_request({ payload: sessionPayload() }, ctx);
  handlers.agent_settled({}, ctx);
  assert.equal(calls.status.at(-1)[1].startsWith("⏲"), true);
  handlers.input({}, ctx);
  assert.deepEqual(calls.status.at(-1), ["idle-compact", undefined], "chip cleared on input");
  mock.timers.tick(60 * 60_000);
  assert.equal(calls.compact, 1, "input cancelled it");
});

test("idle timer stays off for small contexts, the 5-minute cache, or when busy", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());

  process.env.PI_CACHE_RETENTION = "long";
  const small = extension({ usage: { tokens: 50_000, contextWindow: 200_000 } });
  small.handlers.before_provider_request({ payload: sessionPayload() }, small.ctx);
  small.handlers.agent_settled({}, small.ctx);

  const busy = extension();
  busy.ctx.isIdle = () => false;
  busy.handlers.before_provider_request({ payload: sessionPayload() }, busy.ctx);
  busy.handlers.agent_settled({}, busy.ctx);

  process.env.PI_CACHE_RETENTION = "short";
  const short = extension();
  short.handlers.before_provider_request({ payload: sessionPayload() }, short.ctx);
  short.handlers.agent_settled({}, short.ctx);

  mock.timers.tick(60 * 60_000);
  assert.equal(small.calls.compact + busy.calls.compact + short.calls.compact, 0);
});
