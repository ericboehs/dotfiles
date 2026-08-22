import assert from "node:assert/strict";
import test from "node:test";

import sessionScheduler, {
  advanceRecurringTask,
  nextDailyRun,
  normalizeTasksForResume,
  parseClock,
  parseDuration,
} from "../extensions/session-scheduler.ts";

function snapshot(sessionId, tasks) {
  return {
    type: "custom",
    customType: "session-scheduler:snapshot",
    data: { version: 1, sessionId, tasks },
  };
}

async function mount({ branch = [], idle = true, sessionId = "session-a" } = {}) {
  const handlers = {};
  const commands = {};
  const entries = [...branch];
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

test("parses compact durations without a dependency", () => {
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("2d4h5m6s"), 187_506_000);
  assert.equal(parseDuration("0.5h"), 1_800_000);
  assert.equal(parseDuration("1 hour"), undefined);
  assert.equal(parseDuration("garbage"), undefined);
});

test("normalizes 12-hour and 24-hour clock forms", () => {
  assert.equal(parseClock("9a"), "09:00");
  assert.equal(parseClock("9:15am"), "09:15");
  assert.equal(parseClock("12a"), "00:00");
  assert.equal(parseClock("12pm"), "12:00");
  assert.equal(parseClock("21:30"), "21:30");
  assert.equal(parseClock("24:00"), undefined);
  assert.equal(parseClock("13pm"), undefined);
});

test("daily schedules always pick a future local wall-clock time", () => {
  const morning = new Date(2026, 7, 22, 8, 30);
  const sameDay = new Date(nextDailyRun("09:00", morning));
  assert.equal(sameDay.getDate(), 22);
  assert.equal(sameDay.getHours(), 9);
  assert.equal(sameDay.getMinutes(), 0);

  const evening = new Date(2026, 7, 22, 10, 0);
  const tomorrow = new Date(nextDailyRun("09:00", evening));
  assert.equal(tomorrow.getDate(), 23);
  assert.equal(tomorrow.getHours(), 9);
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

test("registers slash commands but no LLM tools", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);
  assert.deepEqual(Object.keys(ui.commands).sort(), ["loop", "schedule"]);
  assert.equal(ui.registeredTools, 0);
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

test("/schedule creates hourly, daily, and one-shot tasks", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "hourly :: check status");
  await ui.run("schedule", "daily 9a :: morning report");
  await ui.run("schedule", "once 5m :: check the build");

  const tasks = latestTasks(ui);
  assert.deepEqual(tasks.map((task) => task.kind), ["interval", "daily", "once"]);
  assert.equal(tasks[0].prompt, "check status");
  assert.equal(tasks[1].dailyAt, "09:00");
  assert.equal(tasks[2].prompt, "check the build");
});

test("list and cancel are handled without waking the model", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "every 5m check CI");
  const id = latestTasks(ui)[0].id;
  await ui.run("schedule", "list");
  assert.match(ui.notices.at(-1).message, new RegExp(id));
  assert.deepEqual(ui.sent, []);

  await ui.run("schedule", `cancel ${id.slice(0, 4)}`);
  assert.equal(latestTasks(ui).length, 0);
  assert.match(ui.notices.at(-1).message, /Cancelled/);
});

test("snapshots are bound to the session id, so forks do not inherit jobs", async (t) => {
  const task = { id: "deadbeef", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("parent-session", [task])], sessionId: "fork-session" });
  t.after(ui.shutdown);

  await ui.run("schedule", "list");
  assert.match(ui.notices.at(-1).message, /No scheduled tasks/);
});

test("resume restores matching future tasks", async (t) => {
  const task = { id: "deadbeef", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("schedule", "list");
  assert.match(ui.notices.at(-1).message, /deadbeef/);
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
