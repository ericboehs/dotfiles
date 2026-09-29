import assert from "node:assert/strict";
import test from "node:test";

import thoughtlessCompaction from "../extensions/thoughtless-compaction.ts";

function setup(model) {
  let handler;
  const calls = [];
  thoughtlessCompaction({
    on(event, candidate) {
      if (event === "session_before_compact") handler = candidate;
    },
  });

  const ctx = {
    model,
    modelRegistry: {
      async complete(...args) {
        calls.push(args);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "## Goal\nKeep working" }],
          usage: { input: 10, output: 5 },
        };
      },
    },
    ui: { notify() {} },
  };

  const event = {
    preparation: {
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
      ],
      turnPrefixMessages: [],
      previousSummary: undefined,
      tokensBefore: 190_000,
      firstKeptEntryId: "keep-from-here",
      fileOps: { read: new Set(), edited: new Set(), written: new Set() },
    },
    signal: new AbortController().signal,
  };

  return { handler, calls, ctx, event };
}

test("Opus 5.5 compacts with low-effort adaptive thinking", async () => {
  const fixture = setup({
    id: "claude-opus-5.5",
    api: "anthropic-messages",
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  });

  const result = await fixture.handler(fixture.event, fixture.ctx);

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][2].thinkingEnabled, true);
  assert.equal(fixture.calls[0][2].effort, "low");
  assert.equal(fixture.calls[0][2].maxTokens, 64_000);
  assert.equal(result.compaction.firstKeptEntryId, "keep-from-here");
  assert.equal(result.compaction.tokensBefore, 190_000);
});

test("adaptive models that permit it compact with thinking disabled", async () => {
  const fixture = setup({
    id: "claude-opus-4.8",
    api: "anthropic-messages",
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  });

  await fixture.handler(fixture.event, fixture.ctx);

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][2].thinkingEnabled, false);
  assert.equal(fixture.calls[0][2].effort, undefined);
});

test("models that cannot disable thinking fall back to Pi compaction", async () => {
  const fixture = setup({
    id: "claude-fable-5",
    api: "anthropic-messages",
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
  });

  const result = await fixture.handler(fixture.event, fixture.ctx);

  assert.equal(result, undefined);
  assert.equal(fixture.calls.length, 0);
});
