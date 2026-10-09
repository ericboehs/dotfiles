/**
 * Tests for the session canvas: pure helpers in canvas.ts, tree readers in
 * canvas/daemon.mjs, and a real daemon on a spare port with a temp root.
 *
 *   node --test .pi-agent/test/canvas.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ActivityTracker, diffSkipReason, filesMarkdown, isSensitivePath, makePatch, findingLine, findingTexts, isSectionId, newFindings, parseExtras, shotsMarkdown, tallyFiles, lastTurn, leftHalfBounds, openTodos, parseStatus, turnDigest, upsertSection, worthStatus } from "../extensions/canvas.ts";
import { allowedHost, listSessions, parseFindings, prune, sessionState } from "../extensions/canvas/daemon.mjs";

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
  for (const p of ["/r/src/app.ts", "/r/README.md", "/r/environment.rb", "/r/keyboard.js"]) assert.ok(!isSensitivePath(p), p);
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
});

test("shotsMarkdown links each copied image and escapes names", () => {
  const md = shotsMarkdown([{ file: "shot-abc.png", name: 'a"<b>.png', at: "2026-10-07T10:00:00.000Z" }], "sess-1");
  assert.match(md, /^<div class="gallery"><figure><a href="\/s\/sess-1\/f\/shot-abc\.png"><img src="\/s\/sess-1\/f\/shot-abc\.png" alt="a&quot;&lt;b&gt;\.png"/);
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
    mk("ask", { pid: process.pid }, { "activity.json": JSON.stringify({ state: "blocked", message: "Allow bash?" }) });
    mk("legacy", { pid: process.pid }, { "activity.json": JSON.stringify({ state: "waiting" }) });
    mk("old", { pid: process.pid }); // written before activity.json existed
    mk("gone", { pid: 999999 }, { "activity.json": JSON.stringify({ state: "working", message: "x" }) });
    assert.equal(sessionState(root, "busy").activity, "working");
    assert.deepEqual([sessionState(root, "ask").activity, sessionState(root, "ask").activityMessage], ["blocked", "Allow bash?"]);
    assert.equal(sessionState(root, "legacy").activity, "done");
    assert.equal(sessionState(root, "old").activity, "done");
    assert.deepEqual([sessionState(root, "gone").activity, sessionState(root, "gone").activityMessage], ["ended", ""]);
    assert.equal(listSessions(root).find((s) => s.id === "ask").activityMessage, "Allow bash?");
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

test("daemon serves pages, state and sections, and refuses bad hosts and paths", async () => {
  const { root, mk } = tempRoot();
  const port = 18790 + Math.floor(Math.random() * 1000);
  mk("s1", { name: "test", pid: process.pid }, {
    "sections.json": JSON.stringify([{ id: "a", kind: "html", file: "a.html", order: 1, at: "t" }]),
    "a.html": "<p>hi</p>",
    "diff-0123abcd.patch": "--- a/x\n+++ b/x\n",
    "base-0123abcd": "secret original",
  });
  // Run it through a symlinked directory, the way pi reaches it via
  // ~/.pi/agent/extensions. A main-module check on raw paths exits silently.
  const link = join(root, ".ext");
  symlinkSync(fileURLToPath(new URL("../extensions/", import.meta.url)), link);
  const daemon = join(link, "canvas", "daemon.mjs");
  const child = spawn(process.execPath, [daemon, "--port", String(port), "--root", root, "--version", "t1"], { stdio: "ignore" });
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
    assert.equal(sec.body, "<p>hi</p>");
    assert.match(sec.headers["content-security-policy"], /connect-src 'none'/);
    assert.equal((await get(port, "/s/s1/f/meta.json")).status, 404);
    const patch = await get(port, "/s/s1/f/diff-0123abcd.patch");
    assert.equal(patch.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal((await get(port, "/s/s1/f/base-0123abcd")).status, 404, "diff bases are never served");
    assert.equal((await get(port, "/s/s1/f/..%2Fs1%2Fmeta.json")).status, 404);
    assert.equal((await get(port, "/s/..%2F..%2Fetc/f/a.html")).status, 404);
    const list = JSON.parse((await get(port, "/api/sessions")).body);
    assert.equal(list[0].id, "s1");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
