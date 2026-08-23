import assert from "node:assert/strict";
import test from "node:test";

import sessionScheduler, {
  advanceRecurringTask,
  nextCronRun,
  nextDailyRun,
  normalizeTasksForResume,
  parseClock,
  parseCron,
  parseDuration,
} from "../extensions/session-scheduler.ts";

function cronAt(expr, from) {
  const fields = parseCron(expr);
  assert.ok(fields, `expected ${expr} to parse`);
  const next = nextCronRun(fields, from);
  return next === undefined ? undefined : new Date(next);
}

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

test("parses standard 5-field cron, with names and steps", () => {
  assert.deepEqual([...parseCron("0 9 * * *").hour], [9]);
  assert.deepEqual([...parseCron("*/15 * * * *").minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron("0 0 * * mon-fri").dow], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 1 jan,jul *").month], [1, 7]);
  assert.deepEqual([...parseCron("0 0 * * 7").dow], [0], "day 7 normalizes to Sunday");
  assert.deepEqual([...parseCron("5/15 * * * *").minute], [5, 20, 35, 50]);
});

test("expands @macros", () => {
  assert.deepEqual([...parseCron("@hourly").minute], [0]);
  assert.deepEqual([...parseCron("@daily").hour], [0]);
  assert.deepEqual([...parseCron("@weekly").dow], [0]);
  assert.equal(parseCron("@nope"), undefined);
});

test("rejects malformed cron rather than silently accepting it", () => {
  assert.equal(parseCron("* * * *"), undefined, "4 fields");
  assert.equal(parseCron("* * * * * *"), undefined, "6 fields (seconds unsupported)");
  assert.equal(parseCron("60 * * * *"), undefined, "minute out of range");
  assert.equal(parseCron("0 24 * * *"), undefined, "hour out of range");
  assert.equal(parseCron("0 0 * * xyz"), undefined, "bad day name");
  assert.equal(parseCron("0 0 * * 5-1"), undefined, "inverted range");
  assert.equal(parseCron("*/0 * * * *"), undefined, "zero step");
});

test("computes the next cron occurrence in local time", () => {
  assert.equal(cronAt("0 9 * * *", new Date(2026, 7, 22, 8, 30)).getHours(), 9);
  assert.equal(cronAt("0 9 * * *", new Date(2026, 7, 22, 9, 30)).getDate(), 23, "rolls to tomorrow");

  const quarter = cronAt("*/15 * * * *", new Date(2026, 7, 22, 10, 7));
  assert.equal(quarter.getMinutes(), 15);

  const yearly = cronAt("@yearly", new Date(2026, 7, 22, 10, 0));
  assert.equal(yearly.getFullYear(), 2027);
  assert.equal(yearly.getMonth(), 0);
  assert.equal(yearly.getDate(), 1);
});

test("dom and dow are OR'd when both are restricted, per Vixie cron", () => {
  // The 13th, or any Friday. 2026-08-22 is a Saturday.
  const next = cronAt("0 0 13 * fri", new Date(2026, 7, 22, 12, 0));
  assert.equal(next.getDate(), 28, "next Friday, not the 13th");
  assert.equal(next.getDay(), 5);

  // Restricted dom with wildcard dow stays an AND, so it must be the 13th.
  const domOnly = cronAt("0 0 13 * *", new Date(2026, 7, 22, 12, 0));
  assert.equal(domOnly.getDate(), 13);
  assert.equal(domOnly.getMonth(), 8, "September");
});

test("an impossible cron date terminates instead of spinning", () => {
  assert.equal(cronAt("0 0 30 2 *", new Date(2026, 7, 22)), undefined, "February 30th");
});

test("/schedule cron creates a task and survives resume", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "cron 0 9 * * 1-5 :: weekday standup");
  const [task] = latestTasks(ui);
  assert.equal(task.kind, "cron");
  assert.equal(task.cronExpr, "0 9 * * 1-5");
  assert.equal(task.prompt, "weekday standup");
  assert.equal(new Date(task.nextRunAt).getHours(), 9);

  await ui.run("schedule", "list");
  assert.match(ui.notices.at(-1).message, /cron 0 9 \* \* 1-5/);
});

test("/schedule cron accepts an @macro and rejects junk", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "cron @daily nightly summary");
  assert.equal(latestTasks(ui)[0].cronExpr, "@daily");

  await ui.run("schedule", "cron 99 * * * * broken");
  assert.equal(ui.notices.at(-1).level, "error");
  assert.equal(latestTasks(ui).length, 1, "the bad expression created nothing");
});

test("a recurring cron task advances past its fire time", () => {
  const fields = parseCron("0 9 * * *");
  const first = nextCronRun(fields, new Date(2026, 7, 22, 8, 0));
  const task = { id: "c", kind: "cron", prompt: "x", createdAt: 0, nextRunAt: first, cronExpr: "0 9 * * *" };
  const advanced = advanceRecurringTask(task, first);
  assert.ok(advanced.nextRunAt > first);
  assert.equal(new Date(advanced.nextRunAt).getDate(), 23);
});

test("a cron task whose expression went bad is dropped, not respun", () => {
  const now = 10_000;
  const result = normalizeTasksForResume(
    [{ id: "bad", kind: "cron", prompt: "x", createdAt: 0, nextRunAt: 1_000, cronExpr: "0 0 30 2 *" }],
    now,
  );
  assert.deepEqual(result.tasks, [], "cannot advance, so it is discarded");
  assert.equal(result.changed, true);
});

test("/schedule pause stops a task firing but keeps it listed", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "once 30s ping");
  const id = latestTasks(ui)[0].id;

  await ui.run("schedule", `pause ${id}`);
  assert.equal(latestTasks(ui)[0].paused, true);
  assert.match(ui.notices.at(-1).message, /Paused 1 task/);

  await ui.run("schedule", "list");
  assert.match(ui.notices.at(-1).message, /paused/);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(ui.sent, [], "a paused task must not fire");
});

test("/schedule resume re-arms and recomputes the next run", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "daily 9a morning report");
  const id = latestTasks(ui)[0].id;

  await ui.run("schedule", `pause ${id}`);
  await ui.run("schedule", `resume ${id}`);

  const task = latestTasks(ui)[0];
  assert.equal(task.paused, false);
  assert.ok(task.nextRunAt > Date.now(), "next run is back in the future");
  assert.match(ui.notices.at(-1).message, /Resumed/);
});

test("pause and resume accept 'all'", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "hourly a");
  await ui.run("schedule", "daily 9a b");
  await ui.run("schedule", "pause all");
  assert.deepEqual(latestTasks(ui).map((task) => task.paused), [true, true]);

  await ui.run("schedule", "resume all");
  assert.deepEqual(latestTasks(ui).map((task) => task.paused), [false, false]);
});

test("pausing is idempotent and reports when there is nothing to do", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "hourly a");
  await ui.run("schedule", "pause all");
  await ui.run("schedule", "pause all");
  assert.match(ui.notices.at(-1).message, /Nothing to pause/);
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

  await ui.run("schedule", "list");
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

  await ui.run("schedule", "resume deadbeef");
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

  await ui.run("schedule", "resume cafe1234");
  const task = latestTasks(ui)[0];
  assert.equal(task.id, "cafe1234");
  assert.ok(task.nextRunAt > Date.now());
  assert.deepEqual(ui.sent, [], "no catch-up burst");
});

test("warns when the session has not been written to disk yet", async (t) => {
  const ui = await mount({ persisted: false });
  t.after(ui.shutdown);

  await ui.run("schedule", "daily 9a morning report");
  const warning = ui.notices.find((n) => /no model reply yet/.test(n.message));
  assert.ok(warning, "expected an unsaved-session warning");
  assert.equal(warning.level, "warning");
  assert.match(ui.notices.at(-1).message, /^Scheduled /, "the confirmation still comes last");
  assert.equal(latestTasks(ui).length, 1, "the task is still created");
});

test("stays quiet once the session has an assistant message", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("schedule", "daily 9a morning report");
  assert.equal(ui.notices.filter((n) => /no model reply yet/.test(n.message)).length, 0);
});
