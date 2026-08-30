/**
 * Finished-turn timing format.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatFinishedTime, formatSummary } from "../extensions/turn-timer.ts";

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
