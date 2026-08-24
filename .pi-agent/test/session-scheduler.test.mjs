import assert from "node:assert/strict";
import test from "node:test";

import sessionScheduler, {
  advanceRecurringTask,
  normalizeTasksForResume,
} from "../extensions/session-scheduler.ts";

function snapshot(sessionId, tasks) {
  return {
    type: "custom",
    customType: "session-scheduler:snapshot",
    data: { version: 1, sessionId, tasks },
  };
}

async function mount({ branch = [], idle = true, sessionId = "session-a", persisted = true } = {}) {
  const handlers = {};
  const commands = {};
  const entries = persisted
    ? [{ type: "message", message: { role: "assistant", content: [] } }, ...branch]
    : [...branch];
  const sent = [];
  const notices = [];
  const statuses = [];
  let isIdle = idle;
  let registeredTools = 0;

  const ctx = {
    hasUI: true,
    isIdle: () => isIdle,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      confirm: async () => true,
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };

  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: () => { registeredTools += 1; },
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (prompt) => {
      sent.push(prompt);
      isIdle = false;
    },
  };

  sessionScheduler(pi);
  await handlers.session_start({ reason: "startup" }, ctx);

  return {
    commands,
    ctx,
    entries,
    handlers,
    notices,
    sent,
    statuses,
    registeredTools,
    setIdle: (value) => { isIdle = value; },
    run: (name, args = "") => commands[name].handler(args, ctx),
    shutdown: () => handlers.session_shutdown({ reason: "quit" }, ctx),
  };
}

function latestTasks(ui) {
  return ui.entries.at(-1)?.data?.tasks ?? [];
}

test("registers only the session-scoped commands, and no LLM tools", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);
  assert.deepEqual(Object.keys(ui.commands).sort(), ["loop", "once"]);
  assert.equal(ui.registeredTools, 0, "scheduling must not enter model context");
});

test("resume skips missed recurring slots and drops expired one-shots", () => {
  const now = 10_000;
  const tasks = [
    { id: "interval", kind: "interval", prompt: "tick", createdAt: 0, nextRunAt: 1_000, intervalMs: 3_000 },
    { id: "old-once", kind: "once", prompt: "old", createdAt: 0, nextRunAt: 9_000 },
    { id: "future-once", kind: "once", prompt: "future", createdAt: 0, nextRunAt: 11_000 },
  ];
  const result = normalizeTasksForResume(tasks, now);
  assert.equal(result.changed, true);
  assert.deepEqual(result.tasks.map((task) => task.id), ["interval", "future-once"]);
  assert.equal(result.tasks[0].nextRunAt, 13_000, "keeps the original interval phase without catch-up");
});

test("advances a recurring interval to the first future slot", () => {
  const task = { id: "x", kind: "interval", prompt: "tick", createdAt: 0, nextRunAt: 1_000, intervalMs: 1_000 };
  assert.equal(advanceRecurringTask(task, 1_000).nextRunAt, 2_000);
  assert.equal(advanceRecurringTask(task, 3_500).nextRunAt, 4_000);
});

test("a cron task whose expression went bad is dropped, not respun", () => {
  const result = normalizeTasksForResume(
    [{ id: "bad", kind: "cron", prompt: "x", createdAt: 0, nextRunAt: 1_000, cronExpr: "0 0 30 2 *" }],
    10_000,
  );
  assert.deepEqual(result.tasks, [], "cannot advance, so it is discarded");
  assert.equal(result.changed, true);
});

test("/loop creates a session snapshot and supports trailing every syntax", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "15m check CI");
  assert.equal(latestTasks(ui).length, 1);
  assert.equal(latestTasks(ui)[0].intervalMs, 900_000);
  assert.equal(latestTasks(ui)[0].prompt, "check CI");

  await ui.run("loop", "review deploy every 1h");
  assert.equal(latestTasks(ui).length, 2);
  assert.equal(latestTasks(ui)[1].intervalMs, 3_600_000);
  assert.equal(latestTasks(ui)[1].prompt, "review deploy");
});

test("/loop rejects an interval below the one-minute floor", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "10s hammer the API");
  assert.equal(ui.notices.at(-1).level, "error");
  assert.match(ui.notices.at(-1).message, /at least 1m/);
  assert.equal(latestTasks(ui).length, 0);
});

test("/once creates a one-shot task and warns that the session must stay open", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "15m check whether the deploy finished");
  const [task] = latestTasks(ui);
  assert.equal(task.kind, "once");
  assert.equal(task.prompt, "check whether the deploy finished");
  assert.ok(task.nextRunAt > Date.now());
  assert.match(ui.notices.at(-1).message, /keep this session open/);
  assert.deepEqual(ui.sent, [], "scheduling must not wake the model");
});

test("/once points at /schedule rather than silently doing nothing on junk", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "check the build");
  assert.match(ui.notices.at(-1).message, /Use \/schedule for tasks that must run/);
  assert.equal(latestTasks(ui).length, 0);
});

test("/once list shows only one-shots, and /once cancel removes them", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "5m check CI");
  await ui.run("once", "at 8p check in on this");
  const oneShot = latestTasks(ui).find((task) => task.kind === "once");

  await ui.run("once", "list");
  const listed = ui.notices.at(-1).message;
  assert.match(listed, new RegExp(oneShot.id));
  assert.doesNotMatch(listed, /check CI/, "the interval task belongs to /loop");

  await ui.run("once", `cancel ${oneShot.id.slice(0, 4)}`);
  assert.deepEqual(latestTasks(ui).map((task) => task.kind), ["interval"]);
});

test("/once list is empty when only recurring tasks exist", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "5m check CI");
  await ui.run("once", "list");
  assert.match(ui.notices.at(-1).message, /No one-shot tasks/);
});

test("/loop list shows every session timer, whatever created it", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "5m check CI");
  await ui.run("once", "8p check in");
  await ui.run("loop", "list");
  const listed = ui.notices.at(-1).message;
  assert.match(listed, /every 5m/);
  assert.match(listed, /once/);
});

test("list and cancel are handled without waking the model", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "every 5m check CI");
  const id = latestTasks(ui)[0].id;
  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, new RegExp(id));
  assert.deepEqual(ui.sent, []);

  await ui.run("loop", `cancel ${id.slice(0, 4)}`);
  assert.equal(latestTasks(ui).length, 0);
  assert.match(ui.notices.at(-1).message, /Cancelled/);
});

test("snapshots are bound to the session id, so forks do not inherit jobs", async (t) => {
  const task = { id: "deadbeef", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("parent-session", [task])], sessionId: "fork-session" });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /No timers in this session/);
});

test("resume restores matching future tasks", async (t) => {
  const task = { id: "deadbeef", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /deadbeef/);
});

test("a cron task is restored from a snapshot rather than filtered out", async (t) => {
  // Regression: the snapshot validator's kind allowlist omitted "cron", so
  // every cron task was silently dropped on resume before its own branch of
  // the validator could run.
  const task = {
    id: "cr0nb00b",
    kind: "cron",
    prompt: "weekday standup",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 3_600_000,
    cronExpr: "0 9 * * 1-5",
  };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /cr0nb00b · cron 0 9 \* \* 1-5/);
});

test("a snapshot with an unparseable cron expression is still rejected", async (t) => {
  const task = {
    id: "badc0de5",
    kind: "cron",
    prompt: "junk",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 3_600_000,
    cronExpr: "99 * * * *",
  };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /No timers in this session/);
});

test("a due task waits for agent_settled when the session is busy", async (t) => {
  const task = { id: "deadbeef", kind: "once", prompt: "wake up", createdAt: Date.now(), nextRunAt: Date.now() + 20 };
  const ui = await mount({ branch: [snapshot("session-a", [task])], idle: false });
  t.after(ui.shutdown);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(ui.sent, []);

  ui.setIdle(true);
  await ui.handlers.agent_settled({}, ui.ctx);
  assert.deepEqual(ui.sent, ["wake up"]);
});

test("an overdue one-shot is discarded on resume instead of catching up", async (t) => {
  const task = { id: "deadbeef", kind: "once", prompt: "stale", createdAt: Date.now() - 2_000, nextRunAt: Date.now() - 1_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  assert.deepEqual(ui.sent, []);
  assert.deepEqual(latestTasks(ui), []);
});

test("/loop pause stops a task firing but keeps it listed", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "30s ping");
  const id = latestTasks(ui)[0].id;

  await ui.run("loop", `pause ${id}`);
  assert.equal(latestTasks(ui)[0].paused, true);
  assert.match(ui.notices.at(-1).message, /Paused 1 task/);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /paused/);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(ui.sent, [], "a paused task must not fire");
});

test("/loop resume re-arms and recomputes the next run", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h morning report");
  const id = latestTasks(ui)[0].id;

  await ui.run("loop", `pause ${id}`);
  await ui.run("loop", `resume ${id}`);

  const task = latestTasks(ui)[0];
  assert.equal(task.paused, false);
  assert.ok(task.nextRunAt > Date.now(), "next run is back in the future");
  assert.match(ui.notices.at(-1).message, /Resumed/);
});

test("pause and resume accept 'all'", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h a");
  await ui.run("loop", "2h b");
  await ui.run("loop", "pause all");
  assert.deepEqual(latestTasks(ui).map((task) => task.paused), [true, true]);

  await ui.run("loop", "resume all");
  assert.deepEqual(latestTasks(ui).map((task) => task.paused), [false, false]);
});

test("pausing is idempotent and reports when there is nothing to do", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h a");
  await ui.run("loop", "pause all");
  await ui.run("loop", "pause all");
  assert.match(ui.notices.at(-1).message, /Nothing to pause/);
});

test("/loop clear drops every session timer", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h a");
  await ui.run("once", "30m b");
  await ui.run("loop", "clear yes");
  assert.deepEqual(latestTasks(ui), []);
  assert.match(ui.notices.at(-1).message, /Cleared all session timers/);
});

test("a paused task survives resume without being advanced or dropped", async (t) => {
  const stale = {
    id: "deadbeef",
    kind: "once",
    prompt: "held",
    createdAt: Date.now() - 10_000,
    nextRunAt: Date.now() - 5_000,
    paused: true,
  };
  const ui = await mount({ branch: [snapshot("session-a", [stale])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /deadbeef/, "kept despite being overdue");
  assert.deepEqual(ui.sent, [], "and it did not fire on restore");
});

test("resuming an overdue one-shot drops it instead of firing late", async (t) => {
  const stale = {
    id: "deadbeef",
    kind: "once",
    prompt: "held",
    createdAt: Date.now() - 10_000,
    nextRunAt: Date.now() - 5_000,
    paused: true,
  };
  const ui = await mount({ branch: [snapshot("session-a", [stale])] });
  t.after(ui.shutdown);

  await ui.run("loop", "resume deadbeef");
  assert.deepEqual(latestTasks(ui), []);
  assert.match(ui.notices.at(-1).message, /passed while paused/);
  assert.deepEqual(ui.sent, []);
});

test("resuming an overdue recurring task advances it rather than dropping it", async (t) => {
  const stale = {
    id: "cafe1234",
    kind: "interval",
    prompt: "tick",
    createdAt: Date.now() - 600_000,
    nextRunAt: Date.now() - 300_000,
    intervalMs: 60_000,
    paused: true,
  };
  const ui = await mount({ branch: [snapshot("session-a", [stale])] });
  t.after(ui.shutdown);

  await ui.run("loop", "resume cafe1234");
  const task = latestTasks(ui)[0];
  assert.equal(task.id, "cafe1234");
  assert.ok(task.nextRunAt > Date.now());
  assert.deepEqual(ui.sent, [], "no catch-up burst");
});

test("warns when the session has not been written to disk yet", async (t) => {
  const ui = await mount({ persisted: false });
  t.after(ui.shutdown);

  await ui.run("loop", "1h morning report");
  const warning = ui.notices.find((n) => /no model reply yet/.test(n.message));
  assert.ok(warning, "expected an unsaved-session warning");
  assert.equal(warning.level, "warning");
  assert.match(ui.notices.at(-1).message, /^Looping /, "the confirmation still comes last");
  assert.equal(latestTasks(ui).length, 1, "the task is still created");
});

test("stays quiet once the session has an assistant message", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h morning report");
  assert.equal(ui.notices.filter((n) => /no model reply yet/.test(n.message)).length, 0);
});
