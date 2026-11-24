// Nightly fix-check round 2, 2026-11-24: proves the `deny.commands` regexes
// in approval-guardian.json against every bypass and false positive the
// review called out, so a future edit to those patterns can't silently
// regress either direction.
//
// Scope: these are the hard `deny` regexes only (tested against the raw
// command text, the way the guardian engine itself runs them). The `..`
// traversal rule from the previous round was removed outright (the review
// showed it missed most real bypasses -- `cd`, variable indirection, symlinks
// -- while also hard-blocking legitimate same-worktree commands like
// `xcodebuild -project ../App.xcodeproj`, which no reviewer could approve
// since a deny is final). Closing that gap now needs resolved-path checking
// in the guardian's own code, not a text regex, so it is left to prose and
// the model reviewer for this round. There is deliberately no test asserting
// the `..` deny rule's absence beyond the inline comment: this file asserts
// what the remaining regex *does*, not what it doesn't contain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const policy = JSON.parse(readFileSync(join(repo, ".pi-agent", "approval-guardian.json"), "utf8"));

function denyCommandMatching(name) {
  const pattern = policy.deny.commands.find((source) => new RegExp(source).source.includes(name));
  assert.ok(pattern, `expected a deny.commands entry mentioning ${name}`);
  return new RegExp(pattern);
}

test("deny.commands has no literal '..' traversal rule (round 1's regex was removed; see file header)", () => {
  for (const source of policy.deny.commands) {
    assert.ok(!source.includes("\\.\\."), `deny.commands should not contain a literal .. pattern: ${source}`);
  }
});

test("screencapture deny rule: bypasses from the fix-check review are caught", () => {
  const re = denyCommandMatching("screencapture");
  const bypasses = [
    "screencapture -x a.png",
    // review: "any -l later on the same line" must not count as the flag.
    "screencapture -x a.png; ls -l",
    // review: "-l" inside a filename must not count as the flag.
    "screencapture -x out-l.png",
    "screencapture -R 0,0,100,100 out.png",
    "screencapture -D 1 out.png",
    "cd /tmp && screencapture -x out.png",
    "screencapture -x out.png | pbcopy",
    "echo hi; screencapture -x out.png",
  ];
  for (const cmd of bypasses) {
    assert.ok(re.test(cmd), `expected deny for: ${cmd}`);
  }
});

test("screencapture deny rule: false positives from the fix-check review are not caught", () => {
  const re = denyCommandMatching("screencapture");
  const falsePositives = [
    // review: the attached form, no space before the window id.
    "screencapture -l123",
    "screencapture -l 123",
    // review: combined short flags (-x and -l together).
    "screencapture -xl 5",
    // review: screencapture as someone else's argument, not the command run.
    "rg screencapture src",
    "grep -rn screencapture .",
    "xcrun simctl io ABCD screenshot out.png",
  ];
  for (const cmd of falsePositives) {
    assert.ok(!re.test(cmd), `expected no deny for: ${cmd}`);
  }
});

test("approval-guardian.json deny.commands all compile as valid regexes", () => {
  for (const source of policy.deny.commands) {
    assert.doesNotThrow(() => new RegExp(source), `invalid regex: ${source}`);
  }
});
