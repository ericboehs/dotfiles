/**
 * Finished-turn timing format and the spinner's waiting-on-user state.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatFinishedTime, formatSummary, workingMessage } from "../extensions/turn-timer.ts";

/** A RunState with every field pinned; tests override what they exercise. */
function runState(overrides = {}) {
  return {
    startedAt: 0,
    steps: 0,
    tools: 0,
    blocked: 0,
    tok: 0,
    thinkTok: 0,
    thinkMs: 0,
    thinkEst: false,
    thinkOpenAt: null,
    thinkMsTurn: 0,
    waitOpenAt: null,
    models: new Map(),
    closed: false,
    ...overrides,
  };
}

test("finished turn summary includes the local completion time", () => {
  const finished = new Date(2026, 0, 5, 17, 3).toISOString();
  assert.equal(
    formatSummary({
      t: finished,
      ms: 19_000,
      steps: 3,
      tools: 2,
      blocked: 0,
      tok: 349,
      thinkTok: 64,
      thinkMs: 4_000,
      thinkEst: false,
      models: [],
    }),
    "⏱ 5:03p: 19s (4s think) · 6.3s/step · 3 steps · 2 tools · 349 tok (64 reason)",
  );
});

test("completion time uses a compact 12-hour clock", () => {
  assert.equal(formatFinishedTime(new Date(2026, 0, 5, 0, 7).toISOString()), "12:07a");
  assert.equal(formatFinishedTime(new Date(2026, 0, 5, 12, 7).toISOString()), "12:07p");
});

test("an open question prompt times the user wait, not the run", () => {
  const now = 5 * 60_000; // 5m into the run, question up for 30s
  const run = runState({ startedAt: 0, steps: 15, thinkMs: 45_000, waitOpenAt: now - 30_000 });
  assert.equal(workingMessage(run, now), "30s Waiting on user...");
});

test("a wait over a minute formats like the run clock does", () => {
  const now = 5 * 60_000;
  const run = runState({ startedAt: 0, steps: 15, waitOpenAt: now - 90_000 });
  assert.equal(workingMessage(run, now), "1m 30s Waiting on user...");
});

test("answering the question flips the spinner back to the run clock", () => {
  const now = 5 * 60_000;
  const run = runState({ startedAt: 0, steps: 15, thinkMs: 45_000 });
  assert.equal(workingMessage(run, now), "Working for 5m 0s · 15 steps · 45s think...");
});

test("the blocked-tool count rides along under the waiting line", () => {
  const now = 90_000;
  const run = runState({ startedAt: 0, blocked: 2, waitOpenAt: now - 30_000 });
  assert.equal(workingMessage(run, now), "30s Waiting on user...\n  2 tool calls blocked");
});
