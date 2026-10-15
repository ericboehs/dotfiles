import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import cacheTrace, { firstDifference, prefixChange, stripCacheControl, TRACE_UNTIL } from "../extensions/cache-trace.ts";

const user = (text, marked = false) => ({ role: "user", content: [{ type: "text", text, ...(marked ? { cache_control: { type: "ephemeral" } } : {}) }] });

test("cache_control is stripped at any depth", () => {
  assert.deepEqual(stripCacheControl([user("hi", true)]), [user("hi")]);
});

test("a moved cache_control marker is not a prefix change", () => {
  const first = { tools: [], system: [], messages: [user("hi", true)].map(stripCacheControl) };
  const second = { tools: [], system: [], messages: [user("hi"), { role: "assistant", content: [] }, user("next", true)].map(stripCacheControl) };
  assert.equal(prefixChange(first, second), undefined);
});

test("a changed earlier message is located without its content", () => {
  const before = { tools: [], system: [], messages: [user("hello world"), user("b")] };
  const after = { tools: [], system: [], messages: [user("hello there"), user("b"), user("c")] };
  assert.deepEqual(prefixChange(before, after), { path: "messages[0].content[0].text@6", before: "string(11)", after: "string(11)" });
});

test("tools and system changes are reported before messages", () => {
  const base = { tools: [{ name: "read" }], system: [{ type: "text", text: "s" }], messages: [user("a")] };
  assert.equal(prefixChange(base, { ...base, tools: [{ name: "read" }, { name: "tool_search" }] }).path, "tools");
  assert.equal(prefixChange(base, { ...base, system: [{ type: "text", text: "s2" }] }).path, "system[0].text@1");
  assert.deepEqual(prefixChange(base, { ...base, messages: [] }), { path: "messages[0]", before: "object{content,role}", after: "absent" });
});

test("firstDifference describes types, never values", () => {
  assert.deepEqual(firstDifference({ a: 1 }, { a: "secret" }, "x"), { path: "x.a", before: "number", after: "string(6)" });
});

// After TRACE_UNTIL the extension registers nothing; skip rather than block every commit.
test("handlers log fingerprints, usage and a miss with its cause", { skip: Date.now() > TRACE_UNTIL && "trace window over: delete cache-trace.ts" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cache-trace-"));
  process.env.PI_CACHE_TRACE_DIR = dir;
  const handlers = {};
  cacheTrace({ on: (name, fn) => (handlers[name] = fn) });
  const ctx = { cwd: "/x/dotfiles", model: { provider: "github-copilot" }, sessionManager: { getSessionId: () => "s1" } };
  const turn = (messages, read, write) => {
    handlers.before_provider_request({ payload: { model: "claude-opus-5.5", system: [{ type: "text", text: "sys" }], tools: [{ name: "read" }], messages } }, ctx);
    handlers.provider_stream_event({ data: { type: "message_start", message: { id: "msg_vrtx_1", usage: { cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: 2 } } } });
    handlers.provider_stream_event({ data: { copilot_usage: { total_nano_aiu: 1_500_000_000 } } });
  };
  turn([user("hello", true)], 0, 10_000);
  turn([user("hello"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("more", true)], 10_000, 50);
  turn([user("HELLO"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("more"), user("again", true)], 0, 10_100);
  delete process.env.PI_CACHE_TRACE_DIR;
  const [file] = readdirSync(dir);
  const rows = readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].change, undefined);
  assert.equal(rows[1].change, null, "cache_control moved, nothing else");
  assert.equal(rows[1].miss, false);
  assert.equal(rows[2].miss, true);
  assert.deepEqual(rows[2].change, { path: "messages[0].content[0].text@0", before: "string(5)", after: "string(5)" });
  assert.equal(rows[2].aiu, 1.5);
  assert.equal(rows[2].session, "s1");
  assert.equal(rows[2].messageHashes.length, 4);
  assert.ok(!JSON.stringify(rows).includes("hello"), "no content in the log");
});
