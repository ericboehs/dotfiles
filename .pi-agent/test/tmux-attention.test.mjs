/**
 * Smoke tests for the tmux attention indicator.
 *
 * The interesting behaviour is the background-task probe: it broadcasts on the
 * shared event bus and the bus cannot say whether anyone is subscribed, so the
 * only way to find out is to ask and wait. These tests pin down that the wait
 * happens once rather than on every turn.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

const BG_REQUEST = "pi-background-tasks:request:v1";
const BG_RESPONSE = "pi-background-tasks:response:v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";

/**
 * Load a fresh copy of the extension.
 *
 * It latches "nobody answered" in module scope, deliberately: the answer holds
 * for the whole process. Tests need that state reset, hence the cache-busting
 * query string.
 */
async function loadExtension() {
  const url = new URL("../extensions/tmux-attention.ts", import.meta.url);
  url.search = `?t=${Math.random()}`;
  return (await import(url.href)).default;
}

/** Build a stub pi with a real-enough event bus, and mount the extension. */
async function mount({ responder } = {}) {
  process.env.TMUX_PANE = "%9";
  const extension = await loadExtension();

  const handlers = new Map();
  const listeners = new Map();
  const execCalls = [];
  const requests = [];

  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    exec: async (command, args) => {
      execCalls.push(args.join(" "));
      // Report the pane as being in a background window, so markWindow()
      // proceeds to set the indicator.
      return { stdout: args[0] === "display-message" ? "0" : "", stderr: "", code: 0 };
    },
    events: {
      on: (channel, handler) => {
        const bucket = listeners.get(channel) ?? new Set();
        bucket.add(handler);
        listeners.set(channel, bucket);
        return () => bucket.delete(handler);
      },
      emit: (channel, data) => {
        if (channel === BG_REQUEST) {
          requests.push(data);
          responder?.(data, pi.events);
        }
        for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
      },
    },
  };

  extension(pi);

  const ctx = { isIdle: () => true };
  return {
    execCalls,
    requests,
    settle: () => handlers.get("agent_settled")(),
    startSession: () => handlers.get("session_start")({}, ctx),
  };
}

/** Answer a probe as pi-background-tasks would, after `delay` ms. */
function respondWith(tasks, delay = 0) {
  return (request, events) => {
    setTimeout(() => {
      events.emit(BG_RESPONSE, {
        schema_version: BG_RESPONSE_SCHEMA,
        request_id: request.request_id,
        ok: true,
        result: { tasks },
      });
    }, delay);
  };
}

/** Milliseconds a promise takes to settle, for asserting a timeout was skipped. */
async function elapsed(fn) {
  const started = Date.now();
  await fn();
  return Date.now() - started;
}

test("with no background-tasks extension, only the first probe pays the timeout", async () => {
  const pi = await mount();

  const first = await elapsed(() => pi.settle());
  assert.ok(first >= 250, `first probe should wait out the timeout, took ${first}ms`);

  const second = await elapsed(() => pi.settle());
  assert.ok(second < 100, `later turns should not wait again, took ${second}ms`);

  assert.equal(pi.requests.length, 1, "silence is latched, so no second broadcast");
  assert.equal(pi.execCalls.length, 4, "both turns still mark the window");
});

test("the one unavoidable probe is spent at startup, not on the first turn", async () => {
  const pi = await mount();

  pi.startSession();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pi.requests.length, 1);

  const turn = await elapsed(() => pi.settle());
  assert.ok(turn < 100, `the first real turn should already know, took ${turn}ms`);
});

test("a responder that answers is asked again every turn", async () => {
  const pi = await mount({ responder: respondWith([]) });

  await pi.settle();
  await pi.settle();

  assert.equal(pi.requests.length, 2, "a live responder must not be short-circuited");
});

test("a running background task suppresses the indicator", async () => {
  const pi = await mount({ responder: respondWith([{ status: "running" }]) });

  await pi.settle();

  assert.deepEqual(pi.execCalls, [], "the completion notification will handle it");
});

test("a reply that lands after the timeout still lifts the silence latch", async () => {
  // The per-request listener is gone by then, so only the long-lived watcher
  // can catch this — and without it a merely-slow responder would be written
  // off for BG_PROBE_RETRY_MS.
  const pi = await mount({ responder: respondWith([], 400) });

  await pi.settle();
  assert.equal(pi.requests.length, 1, "the first probe times out");

  await new Promise((resolve) => setTimeout(resolve, 300));
  await pi.settle();
  assert.equal(pi.requests.length, 2, "the late reply proves someone is listening");
});
