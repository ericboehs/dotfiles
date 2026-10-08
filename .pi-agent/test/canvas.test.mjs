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

import { findingLine, isSectionId, lastTurn, leftHalfBounds, openTodos, parseStatus, turnDigest, upsertSection, worthStatus } from "../extensions/canvas.ts";
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
  assert.deepEqual(lastTurn([]), { user: "", tools: [], files: [], reply: "" });
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
      "status.json": JSON.stringify({ goal: "g", now: "n" }),
      "sections.json": JSON.stringify([{ id: "a", file: "a.md" }]),
      "findings.md": "- [t] x\n",
    });
    mkdirSync(join(root, ".vendor"));
    const list = listSessions(root);
    assert.deepEqual(list.map((s) => s.id), ["live1", "dead1"]);
    assert.equal(list[0].live, true);
    assert.equal(list[0].sections, 1);
    assert.equal(list[0].findings, 1);
    assert.equal(list[1].live, false);
    assert.equal(sessionState(root, "live1").status.goal, "g");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.equal((await get(port, "/s/s1/f/..%2Fs1%2Fmeta.json")).status, 404);
    assert.equal((await get(port, "/s/..%2F..%2Fetc/f/a.html")).status, 404);
    const list = JSON.parse((await get(port, "/api/sessions")).body);
    assert.equal(list[0].id, "s1");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
