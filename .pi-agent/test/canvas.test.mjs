/**
 * Tests for the session canvas: pure helpers in canvas.ts, tree readers in
 * canvas/daemon.mjs, and a real daemon on a spare port with a temp root.
 *
 *   node --test .pi-agent/test/canvas.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import canvasExtension, { ActivityTracker, STATUS_PROMPT, checkChart, compareOptions, normalizeSpec, parseDelimited, diffSkipReason, fileId, filesMarkdown, syncCopies, gitDiff, isSensitivePath, looksLikeDiff, makePatch, findingLine, findingTexts, isSectionId, newFindings, parseExtras, shotsMarkdown, agentTraffic, agentsMarkdown, bashExit, runSpec, streamable, tailLines, readPeers, resolvePeerName, tallyFiles, lastTurn, leftHalfBounds, openTodos, parseStatus, turnDigest, upsertSection, worthStatus } from "../extensions/canvas.ts";
import { allowedHost, clipTarget, listSessions, parseFindings, prune, sessionState, withKit } from "../extensions/canvas/daemon.mjs";

const msg = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });

test("section ids are lowercase slugs", () => {
  assert.equal(isSectionId("hook-points"), true);
  assert.equal(isSectionId("a"), true);
  assert.equal(isSectionId("Plan"), false);
  assert.equal(isSectionId("../x"), false);
  assert.equal(isSectionId("-x"), false);
  assert.equal(isSectionId("x".repeat(65)), false);
  assert.equal(isSectionId(undefined), false);
});

test("lastTurn reads the newest user prompt, tools, files and final reply", () => {
  const branch = [
    msg("user", "old prompt"),
    msg("assistant", [{ type: "text", text: "old reply" }]),
    msg("user", [{ type: "text", text: "plan the canvas" }]),
    msg("assistant", [
      { type: "text", text: "looking" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la\n  ~/x" } },
      { type: "toolCall", id: "c2", name: "edit", arguments: { path: "a.ts", edits: [] } },
    ]),
    msg("toolResult", [{ type: "text", text: "boom" }], { toolCallId: "c1", isError: true }),
    msg("user", "[cross-agent from pi-x] hi"),
    msg("assistant", [{ type: "toolCall", id: "c3", name: "write", arguments: { path: "b.ts" } }, { type: "text", text: "done" }]),
  ];
  const t = lastTurn(branch);
  assert.equal(t.user, "plan the canvas");
  assert.deepEqual(t.tools.map((x) => x.name), ["bash", "edit", "write"]);
  assert.equal(t.tools[0].arg, "ls -la ~/x");
  assert.equal(t.tools[0].error, true);
  assert.equal(t.tools[1].error, false);
  assert.deepEqual(t.files, ["a.ts", "b.ts"]);
  assert.equal(t.reply, "done");
});

test("lastTurn on an empty branch is empty", () => {
  assert.deepEqual(lastTurn([]), { user: "", tools: [], files: [], ops: [], images: [], reply: "" });
});

test("lastTurn collects successful edits and writes, and images the agent read", () => {
  const t = lastTurn([
    msg("user", "fix it"),
    msg("assistant", [
      { type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts", edits: [] } },
      { type: "toolCall", id: "e2", name: "edit", arguments: { path: "a.ts", edits: [] } },
      { type: "toolCall", id: "e3", name: "edit", arguments: { path: "bad.ts", edits: [] } },
      { type: "toolCall", id: "w1", name: "write", arguments: { path: "b.md" } },
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "/tmp/shot.PNG" } },
      { type: "toolCall", id: "r2", name: "read", arguments: { path: "/tmp/shot.PNG" } },
      { type: "toolCall", id: "r3", name: "read", arguments: { path: "notes.md" } },
      { type: "toolCall", id: "r4", name: "read", arguments: { path: "/tmp/gone.png" } },
      { type: "toolCall", id: "k1", name: "canvas", arguments: { kind: "finding", body: "x" } },
      { type: "toolCall", id: "k2", name: "canvas", arguments: { kind: "markdown", id: "t", body: "x" } },
      { type: "toolCall", id: "k3", name: "canvas", arguments: { kind: "markdown", id: "t", remove: true } },
    ]),
    msg("toolResult", [{ type: "text", text: "no match" }], { toolCallId: "e3", isError: true }),
    msg("toolResult", [{ type: "text", text: "ENOENT" }], { toolCallId: "r4", isError: true }),
  ]);
  assert.deepEqual(t.ops, [
    { tool: "edit", path: "a.ts" },
    { tool: "edit", path: "a.ts" },
    { tool: "write", path: "b.md" },
  ]);
  assert.deepEqual(t.images, ["/tmp/shot.PNG"]);
  assert.equal(t.canvasSections, 1);
});

test("parseExtras keeps up to two findings and an auto- prefixed section", () => {
  const reply = JSON.stringify({
    goal: "g",
    findings: ["root cause: x", "", 42, "gotcha: y", "third"],
    section: { id: "Auto-State Matrix!", title: "States", markdown: "| a | b |\n|---|---|" },
  });
  const x = parseExtras(`\`\`\`json\n${reply}\n\`\`\``);
  assert.deepEqual(x.findings, ["root cause: x", "gotcha: y"]);
  assert.deepEqual(x.section, { id: "auto-state-matrix", title: "States", markdown: "| a | b |\n|---|---|" });
  assert.deepEqual(parseExtras('{"goal":"g","findings":[],"section":null}'), { findings: [], section: null });
  assert.deepEqual(parseExtras('{"section":{"title":"Commands","markdown":"  "}}').section, null);
  assert.equal(parseExtras('{"section":{"title":"Run These","markdown":"x"}}').section.id, "auto-run-these");
  assert.deepEqual(parseExtras("not json"), { findings: [], section: null });
});

test("newFindings drops ones already logged, loosely", () => {
  assert.deepEqual(newFindings(["The `ui_prompt_start` event fires.", "New fact", "new fact!"], ["the ui_prompt_start event fires"]), ["New fact"]);
});

test("findingTexts and findingLine with a source", () => {
  const md = findingLine("one\ntwo", "2026-10-07T00:00:00.000Z", "auto") + findingLine("three", "2026-10-07T01:00:00.000Z");
  assert.ok(md.startsWith("- [2026-10-07T00:00:00.000Z · auto] one"));
  assert.deepEqual(findingTexts(md), ["one two", "three"]);
  assert.deepEqual(parseFindings(md), [
    { at: "2026-10-07T00:00:00.000Z", by: "auto", text: "one\ntwo" },
    { at: "2026-10-07T01:00:00.000Z", text: "three" },
  ]);
});

test("tallyFiles and filesMarkdown keep a running table, newest first", () => {
  let files = tallyFiles({}, [{ tool: "write", path: "src/a.ts" }, { tool: "edit", path: "src/a.ts" }], "/repo", "2026-10-07T10:00:00.000Z");
  files = tallyFiles(files, [{ tool: "edit", path: "/repo/b|c.md" }, { tool: "edit", path: "/elsewhere/x" }], "/repo", "2026-10-07T11:00:00.000Z");
  assert.deepEqual(files["/repo/src/a.ts"], { edits: 1, writes: 1, at: "2026-10-07T10:00:00.000Z" });
  const md = filesMarkdown(files, "/repo");
  const rows = md.split("\n").slice(2);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| `b\\\|c\.md` \| 1 edit \|/);
  assert.match(rows[1], /^\| `\/elsewhere\/x` \| 1 edit \|/);
  assert.match(rows[2], /^\| `src\/a\.ts` \| written, 1 edit \|/);
  assert.match(filesMarkdown(files, "/repo", 1), /…and 2 more$/);
});

test("isSensitivePath and diffSkipReason keep secrets and binaries off the page", () => {
  for (const p of ["/r/.env", "/r/.env.local", "/r/server.pem", "/h/.ssh/config", "/r/aws_credentials.json", "/r/id_ed25519", "/r/api-token.txt"]) assert.ok(isSensitivePath(p), p);
  for (const p of ["/r/src/app.ts", "/r/README.md", "/r/environment.rb", "/r/keyboard.js", "/r/tokenizer.ts", "/r/secretary.md"]) assert.ok(!isSensitivePath(p), p);
  const dir = mkdtempSync(join(tmpdir(), "canvas-diff-"));
  try {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, "ok.txt"), "hi\n");
    assert.equal(diffSkipReason(join(dir, "bin.dat")), "binary");
    assert.equal(diffSkipReason(join(dir, "ok.txt")), "");
    assert.equal(diffSkipReason(join(dir, "new.txt")), "", "a missing file is a new file");
    assert.equal(diffSkipReason(join(dir, ".env")), "sensitive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makePatch diffs from the base or from nothing, under the display path", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-diff-"));
  try {
    writeFileSync(join(dir, "base"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "cur.txt"), "one\n2\nthree\nfour\n");
    const p = makePatch(join(dir, "base"), join(dir, "cur.txt"), "src/cur.txt");
    assert.deepEqual([p.adds, p.dels], [2, 1]);
    assert.match(p.patch, /^--- a\/src\/cur\.txt\n\+\+\+ b\/src\/cur\.txt\n@@ /);
    assert.match(p.patch, /^-two$/m);
    const fresh = makePatch(null, join(dir, "cur.txt"), "cur.txt");
    assert.match(fresh.patch, /^--- \/dev\/null\n\+\+\+ b\/cur\.txt/);
    assert.equal(fresh.adds, 4);
    writeFileSync(join(dir, "same"), "one\ntwo\nthree\n");
    assert.deepEqual(makePatch(join(dir, "base"), join(dir, "same"), "same"), { patch: "", adds: 0, dels: 0 });
    const gone = makePatch(join(dir, "base"), join(dir, "deleted"), "deleted");
    assert.match(gone.patch, /\+\+\+ \/dev\/null/);
    assert.equal(gone.dels, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitDiff diffs a ref or range, adds named untracked files and drops secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-git-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  try {
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, ".env"), "KEY=old\n");
    git("add", ".");
    git("commit", "-qm", "first");
    writeFileSync(join(dir, "a.txt"), "one\n2\n");
    writeFileSync(join(dir, ".env"), "KEY=new\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    const all = gitDiff(dir);
    assert.match(all.patch, /^diff --git a\/a\.txt b\/a\.txt$/m);
    assert.ok(!all.patch.includes("KEY="), "the .env change is left out");
    assert.deepEqual(all.dropped, [".env"]);
    assert.ok(!all.patch.includes("new.txt"), "untracked files only when named");
    const named = gitDiff(dir, "HEAD", ["new.txt", "a.txt"]);
    assert.match(named.patch, /\+\+\+ b\/new\.txt\n@@ -0,0 \+1 @@\n\+fresh/);
    assert.ok(looksLikeDiff(named.patch));
    assert.equal(gitDiff(dir, "staged").patch, "");
    git("commit", "-qam", "second");
    assert.match(gitDiff(dir, "HEAD~1..HEAD").patch, /^\+2$/m);
    assert.throws(() => gitDiff(dir, "--output=/tmp/x"), /not a plain ref/);
    assert.throws(() => gitDiff(tmpdir()), /not inside a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesMarkdown links a diffed path to its patch and notes skipped ones", () => {
  const files = tallyFiles({}, [{ tool: "edit", path: "a.ts" }, { tool: "edit", path: ".env" }, { tool: "edit", path: "c.ts" }], "/repo", "2026-10-07T10:00:00.000Z");
  const diffs = {
    "/repo/a.ts": { base: "base-1", patch: "diff-1.patch", adds: 3, dels: 1 },
    "/repo/.env": { base: null, patch: "diff-2.patch", skip: "sensitive" },
    "/repo/c.ts": { base: "base-3", patch: "diff-3.patch" },
  };
  const md = filesMarkdown(files, "/repo", 40, { diffs, sessionId: "s 1" });
  assert.match(md, /\| \[`a\.ts`\]\(\/s\/s%201\/f\/diff-1\.patch\) \| 1 edit · \+3\u00a0−1 \|/);
  assert.match(md, /\| `\.env` \| 1 edit · no diff \(sensitive\) \|/);
  assert.match(md, /\| `c\.ts` \| 1 edit \|/, "no patch yet, no link");

  const copies = { "/repo/a.ts": { file: "cur-1.txt", mtimeMs: 1, size: 1 }, "/repo/c.ts": { file: "cur-3.txt", mtimeMs: 1, size: 1 }, "/repo/.env": { skip: "sensitive" } };
  const both = filesMarkdown(files, "/repo", 40, { diffs, copies, sessionId: "s1" });
  assert.match(both, /\[`a\.ts`\]\(\/s\/s1\/f\/cur-1\.txt#diff\)/, "a copy with a diff");
  assert.match(both, /\[`c\.ts`\]\(\/s\/s1\/f\/cur-3\.txt\)/, "a copy alone");
  assert.match(both, /\| `\.env` \|/);
});

test("syncCopies copies changed files, refreshes on change and drops unfit or deleted ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-copies-"));
  try {
    const d = join(dir, "sess");
    mkdirSync(d);
    const a = join(dir, "a.rb");
    const env = join(dir, ".env");
    const bin = join(dir, "x.bin");
    writeFileSync(a, "one\n");
    writeFileSync(env, "KEY=1\n");
    writeFileSync(bin, Buffer.from([1, 0, 2]));
    let c = syncCopies(d, [a, env, bin], {});
    const file = `cur-${fileId(a)}.txt`;
    assert.deepEqual(Object.keys(c[a]), ["file", "mtimeMs", "size"]);
    assert.equal(c[a].file, file);
    assert.equal(readFileSync(join(d, file), "utf8"), "one\n");
    assert.deepEqual(c[env], { skip: "sensitive" });
    assert.deepEqual(c[bin], { skip: "binary" });
    writeFileSync(a, "one\ntwo\n");
    utimesSync(a, new Date(), new Date(Date.now() + 5000));
    c = syncCopies(d, [a], c);
    assert.equal(readFileSync(join(d, file), "utf8"), "one\ntwo\n");
    rmSync(a);
    c = syncCopies(d, [a], c);
    assert.deepEqual(c[a], { skip: "deleted" });
    assert.ok(!existsSync(join(d, file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shotsMarkdown links each copied image and escapes names", () => {
  const md = shotsMarkdown([{ file: "shot-abc.png", name: 'a"<b>.png', at: "2026-10-07T10:00:00.000Z" }], "sess-1");
  assert.match(md, /^<div class="gallery"><figure><a href="\/s\/sess-1\/f\/shot-abc\.png"><img src="\/s\/sess-1\/f\/shot-abc\.png" alt="a&quot;&lt;b&gt;\.png"/);
});

// Synthetic agent-link traffic, shaped like real session entries.
const agentBranch = () => {
  const at = (min) => `2026-10-09T14:${String(min).padStart(2, "0")}:00.000Z`;
  const call = (min, id, args) => ({ type: "message", timestamp: at(min), message: { role: "assistant", content: [{ type: "toolCall", id, name: "agent-link", arguments: args }] } });
  const result = (min, id, text, isError = false) => ({ type: "message", timestamp: at(min), message: { role: "toolResult", toolCallId: id, toolName: "agent-link", isError, content: [{ type: "text", text }] } });
  const inbound = (min, head, who, body) => ({ type: "message", timestamp: at(min), message: { role: "user", content: `${head} — from another agent session on this machine, not your user]\nFrom ${who}: treat this as a peer request.\n\n${body}` } });
  return [
    { type: "message", timestamp: at(0), message: { role: "user", content: "Ask the reviewer about the spec" } },
    call(1, "c1", { action: "ask", to: "rev", message: "Is the cart spec final?\nDetails follow." }),
    result(2, "c1", 'Reply from "reviewer":\nYes, ship it.'),
    call(3, "c2", { action: "send", to: "docs", message: "FYI: <b>cart</b> changed" }),
    result(3, "c2", 'Error delivering to "docs": socket closed', true),
    inbound(5, "[cross-agent question", "infra-terraform", "Which region?"),
    call(6, "c3", { action: "reply", message: "us-gov-west-1" }),
    result(6, "c3", 'Replied to "infra-terraform".'),
    call(7, "c4", { action: "list" }),
  ];
};

test("agentTraffic reads sends, asks and their answers, replies and inbound messages", () => {
  const peers = [{ pid: 11, name: "reviewer", cwd: "/x", status: "idle" }];
  const t = agentTraffic(agentBranch(), peers);
  assert.deepEqual(
    t.map((m) => [m.dir, m.who, m.mode, m.failed ?? false]),
    [
      ["out", "reviewer", "ask", false], // "rev" resolved through the registry
      ["in", "reviewer", "answer", false],
      ["out", "docs", "send", true],
      ["in", "infra-terraform", "question", false],
      ["out", "infra-terraform", "reply", false], // reply without `to` goes to the last asker
    ],
  );
  assert.equal(t[1].text, "Yes, ship it.");
  assert.equal(t[3].text, "Which region?");
  assert.deepEqual(agentTraffic([{ type: "message", message: { role: "user", content: "hello" } }]), []);
  // Without the registry, the tool result still names who an ask reached.
  assert.equal(agentTraffic(agentBranch())[0].who, "reviewer");
});

test("resolvePeerName follows agent-link: exact, unique prefix, pid, session id", () => {
  const peers = [{ pid: 11, name: "api", cwd: "", status: "idle", sessionId: "s-1" }, { pid: 12, name: "api-specs", cwd: "", status: "idle" }];
  assert.equal(resolvePeerName("api", peers), "api");
  assert.equal(resolvePeerName("api-s", peers), "api-specs");
  assert.equal(resolvePeerName("ap", peers), "ap"); // ambiguous: left as typed
  assert.equal(resolvePeerName("12", peers), "api-specs");
  assert.equal(resolvePeerName("s-1", peers), "api");
});

test("agentsMarkdown: newest exchange first, live state, escaped text, a link to the peer's canvas", () => {
  const peers = [{ pid: 11, name: "reviewer", cwd: "/x/repo", status: "tool:bash", sessionId: "sess-r" }];
  const md = agentsMarkdown(agentBranch().length && agentTraffic(agentBranch(), peers), peers, (sid) => sid === "sess-r");
  const rows = md.split("\n");
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^<details class="agent gone" data-agent="infra-terraform">.*<b>infra-terraform<\/b><span class="n">↑1 ↓1 · /);
  assert.match(rows[0], /<span class="pv">↑ us-gov-west-1<\/span>/);
  // The open list is newest first, and every time is a <time class="rel"> the page can make relative.
  assert.match(rows[0], /<ul><li class="out">.*<li class="in">/);
  assert.match(rows[0], /<span class="when">↑ <time class="rel" datetime="[^"]+">[^<]+<\/time> · /);
  assert.match(rows[1], /class="agent gone" data-agent="docs">.*<b>docs<\/b>.*send \(failed\)<\/span>FYI: &lt;b&gt;cart&lt;\/b&gt; changed/);
  assert.match(rows[2], /class="agent busy" data-agent="reviewer"><summary><span class="dot" title="tool:bash"><\/span><b>reviewer<\/b>/);
  assert.match(rows[2], /<span class="pv">↓ Yes, ship it\.<\/span>/);
  assert.match(rows[2], /<p class="where">\/x\/repo · <a href="\/s\/sess-r">canvas page<\/a><\/p>/);
  assert.ok(!md.includes("\n\n"), "no blank lines: each row stays one HTML block");
});

test("readPeers keeps live registry entries and drops dead ones and this process", () => {
  const d = mkdtempSync(join(tmpdir(), "peers-"));
  writeFileSync(join(d, "a.json"), JSON.stringify({ pid: process.ppid, name: "parent", cwd: "/p", status: "idle", sessionId: "s-p" }));
  writeFileSync(join(d, "b.json"), JSON.stringify({ pid: 999999, name: "dead", cwd: "/d", status: "idle" }));
  writeFileSync(join(d, "c.json"), JSON.stringify({ pid: process.pid, name: "me", cwd: "/m", status: "idle" }));
  writeFileSync(join(d, "d.json"), "{not json");
  assert.deepEqual(readPeers(d).map((p) => p.name), ["parent"]);
  assert.deepEqual(readPeers(join(d, "missing")), []);
  rmSync(d, { recursive: true, force: true });
});

test("short tool-free turns do not trigger a status run", () => {
  assert.equal(worthStatus({ user: "hi", tools: [], files: [], reply: "hello" }), false);
  assert.equal(worthStatus({ user: "hi", tools: [], files: [], reply: "x".repeat(400) }), true);
  assert.equal(worthStatus({ user: "hi", tools: [{ name: "read", arg: "a", error: false }], files: [], reply: "" }), true);
});

test("turnDigest carries previous status, tools, files and todos", () => {
  const d = turnDigest(
    { user: "go", tools: [{ name: "bash", arg: "make", error: true }], files: ["x.ts"], reply: "ok" },
    { goal: "G", now: "N", done: ["d"], open: [], next: [] },
    { name: "s", cwd: "/r", todo: ["[ ] #1 thing"] },
  );
  assert.match(d, /Previous status: \{"goal":"G"/);
  assert.match(d, /- bash: make \(failed\)/);
  assert.match(d, /Files changed: x\.ts/);
  assert.match(d, /- \[ \] #1 thing/);
  assert.match(turnDigest({ user: "", tools: [], files: [], reply: "" }, null), /Previous status: none/);
  const withSecs = turnDigest({ user: "", tools: [], files: [], reply: "" }, null, { sections: [{ id: "plan", title: "Plan", kind: "steps" }, { id: "auto-notes", title: "Notes", kind: "markdown", by: "auto" }] });
  assert.match(withSecs, /- plan: Plan \[steps\] \(agent's\)/);
  assert.match(withSecs, /- auto-notes: Notes \[markdown\] \(yours\)/);
});

test("lastTurn names a canvas post by kind and id, not by its file path", () => {
  const call = (args) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "canvas", arguments: args }] } });
  const t = lastTurn([
    { type: "message", message: { role: "user", content: "post it" } },
    call({ kind: "table", id: "commits-table", path: "/tmp/commits.json" }),
    call({ kind: "finding", body: "x" }),
    call({ kind: "markdown", id: "old", remove: true }),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/a.txt" } }] } },
  ]);
  assert.deepEqual(t.tools.map((x) => x.arg), ["table commits-table", "finding", "remove old", "/tmp/a.txt"]);
});

test("prompt copy points at the newer kinds and keeps bodies out of context", async () => {
  assert.match(STATUS_PROMPT, /restate one on the same topic in another form/);
  let tool;
  const pi = new Proxy({}, { get: (_, k) => (k === "registerTool" ? (d) => (tool = d) : k === "getSessionName" ? () => "" : () => {}) });
  await canvasExtension(pi);
  assert.match(tool.promptSnippet, /checklists, command output, timelines/);
  const rules = tool.promptGuidelines.join("\n");
  assert.match(rules, /a plan \(as steps\)/);
  assert.match(rules, /or a compare section when there is a clear before and after/);
  assert.match(rules, /over ~2 KB, write a file and pass path/);
  for (const k of ["terminal", "stats", "table", "compare", "steps", "json", "timeline"]) assert.match(rules, new RegExp(`\\b${k} for `), `lightest-kind rule names ${k}`);
});

test("parseStatus accepts fenced JSON and clamps lists", () => {
  const s = parseStatus('```json\n{"goal":"Build canvas","now":"testing","done":["a","b","c","d","e","f","g"],"open":[1,"q"],"next":["n"]}\n```');
  assert.equal(s.goal, "Build canvas");
  assert.equal(s.done.length, 6);
  assert.deepEqual(s.open, ["q"]);
  assert.equal(parseStatus("no json here"), null);
  assert.equal(parseStatus('{"goal":""}'), null);
  assert.equal(parseStatus("{broken"), null);
});

test("openTodos keeps open, claimed and blocked tasks", () => {
  const t = openTodos("# Tasks\n- [x] #1 done\n- [ ] #2 open\n- [/] #3 mine [@pi]\n- [!] #4 stuck\n- [-] #5 dropped");
  assert.deepEqual(t, ["[ ] #2 open", "[/] #3 mine [@pi]", "[!] #4 stuck"]);
});

test("upsertSection replaces by id and moves it last", () => {
  const a = { id: "a", title: "A", kind: "markdown", file: "a.md", order: 100, at: "1" };
  const b = { id: "b", title: "B", kind: "markdown", file: "b.md", order: 100, at: "1" };
  const list = upsertSection([a, b], { ...a, title: "A2", at: "2" });
  assert.deepEqual(list.map((s) => `${s.id}:${s.title}`), ["b:B", "a:A2"]);
});

test("findingLine round-trips through parseFindings", () => {
  const text = findingLine("first line\nsecond line", "2026-10-07T00:00:00.000Z") + findingLine("other", "2026-10-07T01:00:00.000Z");
  assert.deepEqual(parseFindings(text), [
    { at: "2026-10-07T00:00:00.000Z", text: "first line\nsecond line" },
    { at: "2026-10-07T01:00:00.000Z", text: "other" },
  ]);
});

test("leftHalfBounds reads display 1 from wrangle displays", () => {
  const out = "0  x=0       y=30      1440x2530\n1  x=-1920   y=351     1920x1080\n";
  assert.deepEqual(leftHalfBounds(out), [-1920, 351, -960, 1431]);
  assert.equal(leftHalfBounds("0  x=0 y=30 1440x900"), undefined);
});

test("allowedHost accepts only loopback names on the port", () => {
  assert.equal(allowedHost("127.0.0.1:8790", 8790), true);
  assert.equal(allowedHost("localhost:8790", 8790), true);
  assert.equal(allowedHost("evil.example:8790", 8790), false);
  assert.equal(allowedHost("127.0.0.1:9999", 8790), false);
  assert.equal(allowedHost(undefined, 8790), false);
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "canvas-test-"));
  const mk = (id, meta, files = {}) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "meta.json"), JSON.stringify({ id, ...meta }));
    for (const [n, v] of Object.entries(files)) writeFileSync(join(root, id, n), v);
  };
  return { root, mk };
}

test("listSessions puts live sessions first and summarizes them", () => {
  const { root, mk } = tempRoot();
  try {
    mk("dead1", { name: "old", pid: 999999, ended: "2026-01-01T00:00:00Z" });
    mk("live1", { name: "now", pid: process.pid }, {
      "status.json": JSON.stringify({ goal: "g", now: "n", open: ["a", "b"], done: ["c"] }),
      "sections.json": JSON.stringify([{ id: "a", file: "a.md" }]),
      "findings.md": "- [t] x\n",
    });
    mkdirSync(join(root, ".vendor"));
    const list = listSessions(root);
    assert.deepEqual(list.map((s) => s.id), ["live1", "dead1"]);
    assert.equal(list[0].live, true);
    assert.equal(list[0].sections, 1);
    assert.equal(list[0].findings, 1);
    assert.deepEqual([list[0].open, list[0].next, list[0].done], [2, 0, 1]);
    assert.deepEqual([list[1].open, list[1].next, list[1].done], [0, 0, 0]);
    assert.equal(list[1].live, false);
    assert.equal(sessionState(root, "live1").status.goal, "g");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon reports pi's program state, done for unknown, ended when pi is gone", () => {
  const { root, mk } = tempRoot();
  try {
    mk("busy", { pid: process.pid }, { "activity.json": JSON.stringify({ state: "working" }) });
    mk("ask", { pid: process.pid }, { "activity.json": JSON.stringify({ state: "blocked", message: "Allow bash?", at: "2026-10-09T18:00:00.000Z" }) });
    mk("legacy", { pid: process.pid }, { "activity.json": JSON.stringify({ state: "waiting" }) });
    mk("old", { pid: process.pid }); // written before activity.json existed
    mk("gone", { pid: 999999 }, { "activity.json": JSON.stringify({ state: "working", message: "x" }) });
    assert.equal(sessionState(root, "busy").activity, "working");
    assert.deepEqual([sessionState(root, "ask").activity, sessionState(root, "ask").activityMessage], ["blocked", "Allow bash?"]);
    assert.equal(sessionState(root, "legacy").activity, "done");
    assert.equal(sessionState(root, "old").activity, "done");
    assert.deepEqual([sessionState(root, "gone").activity, sessionState(root, "gone").activityMessage], ["ended", ""]);
    assert.equal(listSessions(root).find((s) => s.id === "ask").activityMessage, "Allow bash?");
    assert.equal(listSessions(root).find((s) => s.id === "ask").activityAt, "2026-10-09T18:00:00.000Z", "when the state changed, for the waiting banner");
    assert.equal(sessionState(root, "gone").activityAt, undefined, "no change time once pi is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ActivityTracker follows pi's program status rules", () => {
  const t = new ActivityTracker();
  const run = (...events) => {
    for (const e of events) t.handle(typeof e === "string" ? { type: e } : e);
    return t.current();
  };
  const reply = (extra = {}) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", ...extra } });
  assert.deepEqual(t.current(), { state: "idle" }, "starts idle");
  assert.deepEqual(run("agent_start"), { state: "working" });
  assert.deepEqual(run({ type: "message_end", message: { role: "user" } }), { state: "working" }, "user messages do not decide");
  assert.deepEqual(run(reply(), { type: "agent_settled", aborted: false }), { state: "done" });

  // A dialog blocks over everything, the newest one wins, and closing restores.
  assert.deepEqual(run("agent_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow bash?\nrm -rf x" }), { state: "blocked", message: "Allow bash?" });
  assert.deepEqual(run({ type: "ui_prompt_start", kind: "select", title: "Pick" }), { state: "blocked", message: "Pick" });
  assert.deepEqual(run({ type: "ui_prompt_end", kind: "select", title: "Pick" }), { state: "blocked", message: "Allow bash?" });
  assert.deepEqual(run({ type: "ui_prompt_end", kind: "confirm", title: "Allow bash?\nrm -rf x" }), { state: "working" });

  // An error is replaced by a successful retry; a final error sticks.
  assert.deepEqual(run(reply({ stopReason: "error", errorMessage: "server_busy\ndetails" }), reply(), { type: "agent_settled" }), { state: "done" });
  assert.deepEqual(run("agent_start", reply({ stopReason: "error", errorMessage: "\n  quota exceeded\nmore" }), { type: "agent_settled" }), { state: "error", message: "quota exceeded" });

  // Cancelling settles idle.
  assert.deepEqual(run("agent_start", { type: "agent_settled", aborted: true }), { state: "idle" });

  // Compaction is working; a manual one outside a run ends done, a failed one error.
  assert.deepEqual(run({ type: "session_before_compact", reason: "manual" }), { state: "working", message: "Compacting context" });
  assert.deepEqual(run({ type: "session_compact", reason: "manual" }), { state: "done" });
  assert.deepEqual(run({ type: "session_before_compact", reason: "manual" }, { type: "session_compact_failed", reason: "manual", aborted: false, errorMessage: "too big" }), { state: "error", message: "too big" });
  assert.deepEqual(run({ type: "session_before_compact", reason: "manual" }, { type: "session_compact_failed", reason: "manual", aborted: true }), { state: "idle" });
});

test("prune keeps a fresh empty session folder", () => {
  const { root } = tempRoot();
  try {
    mkdirSync(join(root, "empty1"));
    assert.deepEqual(prune(root, 30), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune deletes only old sessions whose pi is gone", () => {
  const { root, mk } = tempRoot();
  try {
    mk("old-dead", { pid: 999999 });
    mk("old-live", { pid: process.pid });
    mk("new-dead", { pid: 999999 });
    const past = new Date(Date.now() - 40 * 86_400_000);
    for (const id of ["old-dead", "old-live"]) {
      utimesSync(join(root, id, "meta.json"), past, past);
      utimesSync(join(root, id), past, past);
    }
    assert.deepEqual(prune(root, 30), ["old-dead"]);
    assert.deepEqual(listSessions(root).map((s) => s.id).sort(), ["new-dead", "old-live"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function post(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("clipTarget clips the real file for a copy, a named copy for a diff, else the session file", () => {
  const { root, mk } = tempRoot();
  try {
    const real = join(root, "work", "page.mjs");
    mkdirSync(join(root, "work"));
    writeFileSync(real, "x");
    mk("s1", { pid: process.pid }, {
      "auto-copies.json": JSON.stringify({ [real]: { file: "cur-aaaaaaaaaaaa.txt" }, "/gone/old.rb": { file: "cur-bbbbbbbbbbbb.txt" } }),
      "auto-diffs.json": JSON.stringify({ [real]: { patch: "diff-aaaaaaaaaaaa.patch" } }),
      "cur-aaaaaaaaaaaa.txt": "x",
      "cur-bbbbbbbbbbbb.txt": "y",
      "diff-aaaaaaaaaaaa.patch": "p",
      "plan.md": "# p",
      "base-aaaaaaaaaaaa": "x",
    });
    const dir = join(root, "s1");
    assert.deepEqual(clipTarget(root, "s1", "cur-aaaaaaaaaaaa.txt"), { path: real });
    assert.deepEqual(clipTarget(root, "s1", "cur-bbbbbbbbbbbb.txt"), { copy: [join(dir, "cur-bbbbbbbbbbbb.txt"), "old.rb"] }, "gone: the copy, under its name");
    assert.deepEqual(clipTarget(root, "s1", "diff-aaaaaaaaaaaa.patch"), { copy: [join(dir, "diff-aaaaaaaaaaaa.patch"), "page.mjs.patch"] });
    assert.deepEqual(clipTarget(root, "s1", "plan.md"), { path: join(dir, "plan.md") });
    assert.equal(clipTarget(root, "s1", "base-aaaaaaaaaaaa"), null);
    assert.equal(clipTarget(root, "s1", "nope.md"), null);
    assert.equal(clipTarget(root, "../s1", "plan.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withKit puts the kit and frame script at the top of the head, unless the page opts out", () => {
  const css = ":root{--x:1}";
  const full = withKit("<!doctype html><html><head><title>t</title></head><body>b</body></html>", css);
  assert.match(full, /^<!doctype html><html><head><style id="canvas-kit">\n:root\{--x:1\}<\/style>\n<script>[\s\S]+<\/script>\n<title>t<\/title>/);
  assert.match(withKit("<html lang=en><body>b</body></html>", css), /^<html lang=en><style id="canvas-kit">/);
  assert.match(withKit("<!DOCTYPE html>\n<div>x</div>", css), /^<!DOCTYPE html><style id="canvas-kit">/, "never before the doctype");
  assert.match(withKit("<div>x</div>", css), /^<!doctype html>\n<style id="canvas-kit">[\s\S]*<div>x<\/div>$/, "a fragment gets a doctype");
  const off = withKit('<head><meta name="canvas-kit" content="off"></head>', css);
  assert.doesNotMatch(off, /canvas-kit">/);
  assert.match(off, /<script>[\s\S]*canvasFrame/, "the frame script stays, so the frame still sizes");
});

test("checkChart accepts good specs and explains bad ones", () => {
  const ok = (s) => assert.equal(checkChart(JSON.stringify(s)), "");
  ok({ type: "bar", labels: ["a", "b"], series: [{ name: "x", data: [1, null] }] });
  ok({ type: "scatter", series: [{ data: [[1, 2], { x: 3, y: 4 }] }] });
  ok({ type: "donut", labels: ["a", "b"], series: [{ data: [3, 0] }] });
  assert.match(checkChart("{nope"), /must be JSON/);
  assert.match(checkChart("[]"), /JSON object/);
  assert.match(checkChart('{"type":"radar","series":[]}'), /bar, line, area, scatter, pie, donut/);
  assert.match(checkChart('{"type":"bar","series":[]}'), /needs series/);
  assert.match(checkChart('{"type":"line","labels":["a"],"series":[{"data":["1"]}]}'), /must be numbers/);
  assert.match(checkChart('{"type":"line","labels":["a","b"],"series":[{"data":[1]}]}'), /has 1 values but there are 2 labels/);
  assert.match(checkChart('{"type":"line","series":[{"data":[1]}]}'), /needs labels/);
  assert.match(checkChart('{"type":"scatter","series":[{"data":[1,2]}]}'), /\[x, y\] pairs/);
  assert.match(checkChart('{"type":"pie","labels":["a"],"series":[{"data":[-1]}]}'), /one series of values that aren't negative/);
});

test("normalizeSpec: terminal takes plain text or a spec, and keeps only known fields", () => {
  assert.deepEqual(JSON.parse(normalizeSpec("terminal", "\x1b[31mboom\x1b[0m\n")), { output: "\x1b[31mboom\x1b[0m\n" });
  assert.deepEqual(JSON.parse(normalizeSpec("terminal", '{"ok":true}')), { output: '{"ok":true}' }, "a command's own JSON is output");
  const s = JSON.parse(normalizeSpec("terminal", JSON.stringify({ command: "npm test", output: "x", exit: 1, duration: 4.2, cwd: "/tmp", junk: 1 })));
  assert.deepEqual(s, { command: "npm test", cwd: "/tmp", exit: 1, duration: 4.2, output: "x" });
  assert.throws(() => normalizeSpec("terminal", '{"output":"x","exit":"1"}'), /exit must be an integer/);
  assert.throws(() => normalizeSpec("terminal", '{"output":"x","command":["ls"]}'), /command must be a string/);
});

test("normalizeSpec: stats takes a list or {items} and explains bad items", () => {
  assert.deepEqual(JSON.parse(normalizeSpec("stats", '[{"label":"Tests","value":31,"delta":2}]')), { items: [{ label: "Tests", value: 31, delta: 2 }] });
  assert.equal(JSON.parse(normalizeSpec("stats", '{"items":[{"label":"p95","value":"120 ms","good":"down","spark":[1,null,3]}]}')).items[0].good, "down");
  assert.throws(() => normalizeSpec("stats", "[]"), /needs items/);
  assert.throws(() => normalizeSpec("stats", '[{"value":1}]'), /items\[0\] needs a label/);
  assert.throws(() => normalizeSpec("stats", '[{"label":"a","value":null}]'), /value must be a number or text/);
  assert.throws(() => normalizeSpec("stats", '[{"label":"a","value":1,"good":"left"}]'), /up, down or none/);
  assert.throws(() => normalizeSpec("stats", '[{"label":"a","value":1,"spark":["1"]}]'), /spark must be numbers/);
  assert.throws(() => normalizeSpec("stats", "{nope"), /stats body must be JSON/);
});

test("normalizeSpec: table takes rows with or without columns, or CSV/TSV", () => {
  assert.deepEqual(JSON.parse(normalizeSpec("table", '[{"a":1}]')), { rows: [{ a: 1 }] });
  const t = JSON.parse(normalizeSpec("table", JSON.stringify({ columns: ["name", { label: "Size", type: "bar" }], rows: [["x", 3]] })));
  assert.equal(t.columns[1].type, "bar");
  assert.throws(() => normalizeSpec("table", '{"rows":[]}'), /table needs rows/);
  assert.throws(() => normalizeSpec("table", '{"rows":[1]}'), /array of cells or an object/);
  assert.throws(() => normalizeSpec("table", '{"columns":["a"],"rows":[[1,2]]}'), /rows\[0\] has more cells than there are columns \(1\)/);
  assert.throws(() => normalizeSpec("table", '{"columns":[{"label":"a","type":"pie"}],"rows":[[1]]}'), /type must be one of/);
  const csv = JSON.parse(normalizeSpec("table", 'repo,stars,note\napi,12,"a, b"\nweb,3.5,"say ""hi"""\n', ".csv"));
  assert.deepEqual(csv, { columns: [{ label: "repo" }, { label: "stars" }, { label: "note" }], rows: [["api", 12, "a, b"], ["web", 3.5, 'say "hi"']] });
  assert.deepEqual(parseDelimited("a\tb\r\n1\tx\r\n", "\t"), { columns: [{ label: "a" }, { label: "b" }], rows: [[1, "x"]] });
});

test("normalizeSpec: steps, json and timeline", () => {
  assert.deepEqual(JSON.parse(normalizeSpec("steps", '["plan",{"label":"build","status":"done","note":"ok"}]')), { steps: [{ label: "plan", status: "todo" }, { label: "build", status: "done", note: "ok" }] });
  assert.equal(JSON.parse(normalizeSpec("steps", '{"title":"Ship","steps":["a"]}')).title, "Ship");
  assert.throws(() => normalizeSpec("steps", "[]"), /steps needs steps/);
  assert.throws(() => normalizeSpec("steps", '[{"label":"a","status":"maybe"}]'), /steps\[0\]\.status must be one of/);
  assert.throws(() => normalizeSpec("steps", '[{"status":"done"}]'), /steps\[0\] needs a label/);

  const raw = '{\n  "b": 1,\n  "a": [true, null]\n}';
  assert.equal(normalizeSpec("json", raw), raw, "json is kept as written");
  assert.equal(normalizeSpec("json", "42"), "42");
  assert.throws(() => normalizeSpec("json", "{a:1}"), /json body must be JSON/);

  assert.deepEqual(JSON.parse(normalizeSpec("timeline", '[{"at":"2025-10-09T12:00:00Z","title":"deploy","tone":"ok"}]')), { events: [{ at: "2025-10-09T12:00:00Z", title: "deploy", tone: "ok" }] });
  assert.equal(JSON.parse(normalizeSpec("timeline", '{"events":[{"title":"x"}],"order":"given"}')).order, "given");
  assert.throws(() => normalizeSpec("timeline", '{"events":[]}'), /timeline needs events/);
  assert.throws(() => normalizeSpec("timeline", '[{"at":"now"}]'), /events\[0\] needs a title/);
  assert.throws(() => normalizeSpec("timeline", '[{"title":"x","tone":"pink"}]'), /tone must be one of/);
  assert.throws(() => normalizeSpec("timeline", '[{"title":"x","at":{}}]'), /at must be/);
  assert.throws(() => normalizeSpec("timeline", '{"events":[{"title":"x"}],"order":"random"}'), /order must be time or given/);
});

test("Running: tail, exit code, secret commands and the spec", () => {
  assert.equal(tailLines("a\nb\nc\nd", 2), "c\nd");
  assert.equal(tailLines("a\nb", 5), "a\nb");
  assert.deepEqual(bashExit("built\n\nCommand exited with code 2", true), { output: "built", exit: 2 });
  assert.deepEqual(bashExit("all good", false), { output: "all good", exit: 0 });
  assert.deepEqual(bashExit("partial\n\nCommand timed out after 30 seconds", true), { output: "partial\n\nCommand timed out after 30 seconds", exit: undefined });
  assert.ok(streamable("npm test && make build"));
  assert.ok(streamable("bin/environment-check"));
  for (const c of ["op read op://x/y", "security find-generic-password -s x -w", "printenv", "gh auth token", "env | sort", "ls; env"]) assert.ok(!streamable(c), c);
  const t0 = Date.parse("2026-10-09T12:00:00Z");
  const live = JSON.parse(runSpec({ command: "make", cwd: "/w", started: t0, output: "1\n2" }));
  assert.deepEqual(live, { command: "make", cwd: "/w", output: "1\n2", started: "2026-10-09T12:00:00.000Z", running: true });
  const done = JSON.parse(runSpec({ command: "make", cwd: "/w", started: t0, output: "ok", ended: t0 + 72_400, exit: 0 }));
  assert.equal(done.running, false);
  assert.equal(done.duration, 72);
  assert.equal(done.exit, 0);
  // The spec survives normalizeSpec with its running fields; a bad start is dropped.
  assert.equal(JSON.parse(normalizeSpec("terminal", JSON.stringify(live))).running, true);
  assert.equal(JSON.parse(normalizeSpec("terminal", JSON.stringify({ ...live, started: "soon" }))).running, undefined);
});

test("compareOptions checks labels and mode", () => {
  assert.deepEqual(compareOptions(undefined), {});
  assert.deepEqual(compareOptions('{"labels":["main","branch"],"mode":"onion"}'), { labels: ["main", "branch"], mode: "onion" });
  assert.throws(() => compareOptions('{"labels":["one"]}'), /two strings/);
  assert.throws(() => compareOptions('{"mode":"flip"}'), /slider, side, onion/);
});

test("daemon serves pages, state and sections, and refuses bad hosts and paths", async () => {
  const { root, mk } = tempRoot();
  const port = 18790 + Math.floor(Math.random() * 1000);
  mk("s1", { name: "test", pid: process.pid }, {
    "sections.json": JSON.stringify([
      { id: "a", kind: "html", file: "a.html", order: 1, at: "t" },
      { id: "p", kind: "html-plan", file: "p.html", order: 2, at: "t" },
      { id: "c", kind: "chart", file: "c.chart", order: 3, at: "t" },
    ]),
    "a.html": "<p>hi</p>",
    "p.html": "<!doctype html><p>plan</p>",
    "c.chart": '{"type":"bar","labels":["a"],"series":[{"data":[1]}]}',
    "t.term": '{"output":"ok"}',
    "j.jsonv": '{"a":1}',
    "s.steps": '{"steps":[]}',
    "l.timeline": '{"events":[]}',
    "k.compare": '{"before":"k-before.png","after":"k-after.png"}',
    "k-before.png": "png",
    "diff-0123abcd.patch": "--- a/x\n+++ b/x\n",
    "cur-0123abcd.txt": "<script>alert(1)</script>",
    "base-0123abcd": "secret original",
  });
  // Run it through a symlinked directory, the way pi reaches it via
  // ~/.pi/agent/extensions. A main-module check on raw paths exits silently.
  const link = join(root, ".ext");
  symlinkSync(fileURLToPath(new URL("../extensions/", import.meta.url)), link);
  const daemon = join(link, "canvas", "daemon.mjs");
  // agent-link's registry: one live agent (the test runner), one dead, one with a folder that must not leak.
  const peersDir = join(root, "peers");
  mkdirSync(peersDir);
  writeFileSync(join(peersDir, "1.json"), JSON.stringify({ pid: process.pid, name: "reviewer", status: "tool:bash", cwd: "/secret/folder", sessionId: "sid-1" }));
  writeFileSync(join(peersDir, "2.json"), JSON.stringify({ pid: 999999, name: "dead", status: "idle" }));
  const child = spawn(process.execPath, [daemon, "--port", String(port), "--root", root, "--omarchy", join(root, "no-omarchy"), "--peers", peersDir, "--version", "t1"], { stdio: "ignore" });
  try {
    let up;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      up = await get(port, "/health").catch(() => undefined);
    }
    assert.equal(JSON.parse(up.body).version, "t1");
    assert.equal((await get(port, "/health", "evil.example")).status, 421);
    const page = await get(port, "/s/s1");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    const state = JSON.parse((await get(port, "/api/s/s1")).body);
    assert.equal(state.meta.name, "test");
    assert.equal(state.sections[0].id, "a");
    const sec = await get(port, "/s/s1/f/a.html");
    assert.match(sec.body, /^<!doctype html>\n<style id="canvas-kit">[\s\S]*--c1:[\s\S]*<\/style>\n<script>[\s\S]*canvasFrame[\s\S]*<\/script>\n<p>hi<\/p>$/, "html sections get the kit and frame script");
    assert.match(sec.headers["content-security-policy"], /connect-src 'none'/);
    assert.equal((await get(port, "/s/s1/f/p.html")).body, "<!doctype html><p>plan</p>", "html-plan is served as is");
    const chart = await get(port, "/s/s1/f/c.chart");
    assert.equal(chart.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(JSON.parse(chart.body).type, "bar");
    assert.equal((await get(port, "/s/s1/f/t.term")).headers["content-type"], "application/json; charset=utf-8");
    for (const f of ["j.jsonv", "s.steps", "l.timeline"]) assert.equal((await get(port, `/s/s1/f/${f}`)).status, 200, f);
    assert.equal(JSON.parse((await get(port, "/s/s1/f/k.compare")).body).after, "k-after.png");
    assert.equal((await get(port, "/s/s1/f/k-before.png")).headers["content-type"], "image/png", "compare images are served");
    for (const a of ["page.mjs", "theme.mjs", "nav.mjs", "theme-boot.js"]) assert.equal((await get(port, `/assets/${a}`)).headers["content-type"], "text/javascript; charset=utf-8", a);
    assert.ok(Object.keys(JSON.parse((await get(port, "/assets/themes.json")).body).themes).length >= 20, "Omarchy themes are served");
    assert.match(page.body, /<script src="\/assets\/theme-boot\.js"><\/script>[\s\S]*page\.mjs/, "the theme boot script runs before the page module");
    assert.match(sec.body, /canvasTheme/, "html frames listen for the theme");
    assert.equal((await get(port, "/s/s1/f/meta.json")).status, 404);
    const patch = await get(port, "/s/s1/f/diff-0123abcd.patch");
    assert.equal(patch.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal((await get(port, "/s/s1/f/base-0123abcd")).status, 404, "diff bases are never served");
    const copy = await get(port, "/s/s1/f/cur-0123abcd.txt");
    assert.equal(copy.status, 200);
    assert.match(copy.headers["content-type"], /^text\/plain/, "file copies never render as html");
    assert.equal((await get(port, "/s/s1/f/..%2Fs1%2Fmeta.json")).status, 404);
    assert.equal((await get(port, "/s/..%2F..%2Fetc/f/a.html")).status, 404);
    // Clip: only from the page itself, only for the session's files. (No
    // request here gets through to clippy, so the clipboard stays untouched.)
    assert.equal((await post(port, "/s/s1/clip", { file: "a.html" }, {})).status, 403, "needs the page's header");
    assert.equal((await post(port, "/s/s1/clip", { file: "a.html" }, { "x-canvas-clip": "1", origin: "https://evil.example" })).status, 403, "foreign origin");
    assert.equal((await post(port, "/s/s1/clip", { file: "a.html" }, { "x-canvas-clip": "1", origin: "null" })).status, 403, "an opaque-origin html frame");
    assert.equal((await post(port, "/s/s1/clip", { file: "base-0123abcd" }, { "x-canvas-clip": "1" })).status, 404, "bases are never clipped");
    assert.equal((await post(port, "/s/s1/clip", { file: "../s1/meta.json" }, { "x-canvas-clip": "1" })).status, 404);
    assert.equal((await post(port, "/s/s1/f/a.html", {}, { "x-canvas-clip": "1" })).status, 405, "everything else stays read-only");
    const list = JSON.parse((await get(port, "/api/sessions")).body);
    assert.equal(list[0].id, "s1");
    assert.deepEqual(JSON.parse((await get(port, "/api/system-theme")).body), { theme: null }, "no Omarchy here");
    assert.deepEqual(JSON.parse((await get(port, "/api/peers")).body), { peers: [{ name: "reviewer", status: "tool:bash" }] }, "live agents only, name and status only");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon follows the Omarchy theme: serves it, and tells pages when it switches", async () => {
  const { root } = tempRoot();
  const port = 19790 + Math.floor(Math.random() * 1000);
  // A fake ~/.local/state/omarchy/current, switched the way omarchy-theme-set
  // does it: stage next-theme, rm the theme folder, mv the stage in, write theme.name.
  const cur = join(root, ".omarchy-current");
  const put = (name, bg, fg) => {
    const next = join(cur, "next-theme");
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, "colors.toml"), `mode = "dark"\naccent = "#7aa2f7"\nbackground = "${bg}"\nforeground = "${fg}"\n`);
    rmSync(join(cur, "theme"), { recursive: true, force: true });
    execFileSync("mv", [next, join(cur, "theme")]);
    writeFileSync(join(cur, "theme.name"), `${name}\n`);
  };
  put("tokyo-night", "#1a1b26", "#a9b1d6");
  const link = join(root, ".ext");
  symlinkSync(fileURLToPath(new URL("../extensions/", import.meta.url)), link);
  const child = spawn(process.execPath, [join(link, "canvas", "daemon.mjs"), "--port", String(port), "--root", root, "--omarchy", cur, "--version", "t2"], { stdio: "ignore" });
  let stream;
  try {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await get(port, "/health").catch(() => undefined)) break;
    }
    const first = JSON.parse((await get(port, "/api/system-theme")).body).theme;
    assert.equal(first.name, "tokyo-night");
    assert.equal(first.colors.background, "#1a1b26");
    const got = new Promise((resolve, reject) => {
      stream = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let buf = "";
        res.on("data", (d) => {
          buf += d;
          const m = buf.match(/event: system-theme\ndata: (.*)\n/);
          if (m) resolve(JSON.parse(m[1]));
        });
      });
      stream.on("error", reject);
      stream.end();
      setTimeout(() => reject(new Error("no system-theme event")), 4000);
    });
    await new Promise((r) => setTimeout(r, 300));
    put("flexoki-light", "#fffcf0", "#100f0f");
    assert.deepEqual(await got, { name: "flexoki-light" });
    assert.equal(JSON.parse((await get(port, "/api/system-theme")).body).theme.colors.background, "#fffcf0");
  } finally {
    stream?.destroy();
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
