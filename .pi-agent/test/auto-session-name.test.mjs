/**
 * Unit tests for auto-session-name helpers.
 *
 *   node --test .pi-agent/test/auto-session-name.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isUserGivenName, recentContext, sanitizeName, titleFromContent } from "../extensions/auto-session-name.ts";

test("empty and derived peer ids are not user-given", () => {
  assert.equal(isUserGivenName(undefined), false);
  assert.equal(isUserGivenName(""), false);
  assert.equal(isUserGivenName("   "), false);
  assert.equal(isUserGivenName("pi-dotfiles"), false);
  assert.equal(isUserGivenName("pi-dotfiles-2"), false);
  assert.equal(isUserGivenName("pi-veterans-identification-card-vic-code"), false);
});

test("real titles count as user-given", () => {
  assert.equal(isUserGivenName("daily-nvim"), true);
  assert.equal(isUserGivenName("tmux-session-statusline"), true);
  assert.equal(isUserGivenName("psst"), true);
});

test("sanitizeName lowercases and hyphenates", () => {
  assert.equal(sanitizeName('  "Fix the footer."  '), "fix-the-footer");
  assert.equal(sanitizeName("tmux status line"), "tmux-status-line");
});

test("titleFromContent drops thinking and instruction echo", () => {
  assert.equal(
    titleFromContent([
      { type: "thinking", thinking: "The user wants a short title" },
      { type: "text", text: "Fix tmux status line" },
    ]),
    "fix-tmux-status-line",
  );
  assert.equal(
    titleFromContent([{ type: "text", text: "The user wants a short title (at most 6 words) for a coding-" }]),
    "",
  );
  assert.equal(
    titleFromContent([{ type: "text", text: "one two three four five six seven eight" }]),
    "one-two-three-four-five-six",
  );
});

test("recentContext prefers later turns", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", content: "hello" } },
    { type: "message", message: { role: "user", content: "price of glm 5.3" } },
  ];
  const ctx = recentContext(branch);
  assert.match(ctx, /price of glm 5.3/);
  assert.match(ctx, /hi/);
});
