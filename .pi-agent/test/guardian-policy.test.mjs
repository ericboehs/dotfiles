// Nightly fix-check round 3, 2026-11-24: the screencapture `deny.commands`
// regex (round 2) kept failing in both directions -- it missed common
// bypasses (prefixes, paths, subshells, heredocs) while still blocking the
// report writes its own prose authorizes. A regex over raw command text
// can't win that fight in either direction, so the regex is removed
// outright, same as the `..` traversal rule was in round 2. Both gaps are
// closed in `policy` prose instead: this file asserts that no regex exists
// for either (round 1/2's rules can't silently come back) and that the
// prose actually says what fix-check needs it to say.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const policy = JSON.parse(readFileSync(join(repo, ".pi-agent", "approval-guardian.json"), "utf8"));

test("deny.commands has no regex for screencapture or '..' traversal (both are prose-only)", () => {
  for (const source of policy.deny.commands) {
    assert.ok(!/screencapture/i.test(source), `deny.commands should not mention screencapture: ${source}`);
    assert.ok(!source.includes("\\.\\."), `deny.commands should not contain a literal .. pattern: ${source}`);
    // A literal-source check alone passes `\.{2}` or `[.][.]`, which match
    // `../` exactly as well as `\.\.` would -- check actual behavior too,
    // not just one way to spell the pattern.
    assert.ok(!new RegExp(source).test("../"), `deny.commands should not match '../' by any spelling: ${source}`);
  }
});

test("approval-guardian.json deny.commands all compile as valid regexes", () => {
  for (const source of policy.deny.commands) {
    assert.doesNotThrow(() => new RegExp(source), `invalid regex: ${source}`);
  }
});

test("prose: only screencapture -l <windowid> on the worker's own build is authorized", () => {
  assert.match(policy.policy, /screencapture -l <windowid>/);
  assert.match(policy.policy, /window id of the worker's own build/);
});

test("prose: any screencapture not limited to -l <own build window> is a private-data capture that needs Eric", () => {
  assert.match(policy.policy, /Any `screencapture` invocation that is not limited to exactly `-l/);
  assert.match(policy.policy, /is a private-data capture/);
  assert.match(policy.policy, /needs Eric's explicit authorization/);
});

test("prose: the screencapture rule applies regardless of how the command is spelled or wrapped", () => {
  assert.match(policy.policy, /however it is spelled or wrapped/);
  assert.match(policy.policy, /score it low regardless of flags, wrapping, prefixes, or path/);
});

test("prose: merely mentioning or quoting screencapture (reports, heredocs, grep) is not a capture", () => {
  assert.match(policy.policy, /merely mentions, quotes, or greps for `screencapture` without running it/);
  assert.match(policy.policy, /is not a capture and is not covered by this rule/);
});
