import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSchedule,
  describeSchedule,
  firstRunAfter,
  formatDuration,
  nextCronRun,
  nextDailyRun,
  parseClock,
  parseCron,
  parseDuration,
  parseOnceCommand,
  parseScheduleSpec,
} from "../extensions/lib/schedule-core.ts";

function cronAt(expr, from) {
  const fields = parseCron(expr);
  assert.ok(fields, `expected ${expr} to parse`);
  const next = nextCronRun(fields, from);
  return next === undefined ? undefined : new Date(next);
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

test("intervals keep their phase instead of restarting from now", () => {
  const schedule = { kind: "interval", intervalMs: 1_000 };
  assert.equal(advanceSchedule(schedule, 1_000, 1_000), 2_000);
  assert.equal(advanceSchedule(schedule, 1_000, 3_500), 4_000, "skips missed slots, no catch-up burst");
});

test("advancing a one-shot yields nothing, which is how callers retire it", () => {
  assert.equal(advanceSchedule({ kind: "once" }, 1_000, 2_000), undefined);
  assert.equal(firstRunAfter({ kind: "once" }), undefined);
});

test("advancing a cron whose expression went bad yields nothing", () => {
  assert.equal(
    advanceSchedule({ kind: "cron", cronExpr: "0 0 30 2 *" }, 1_000, 2_000),
    undefined,
    "February 30th can never match",
  );
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

test("/once accepts a leading time, with or without a preposition", () => {
  const now = new Date(2026, 7, 22, 8, 30).getTime();

  assert.deepEqual(parseOnceCommand("15m check the build", now), {
    nextRunAt: now + 900_000,
    prompt: "check the build",
  });
  assert.deepEqual(parseOnceCommand("in 15m check the build", now), {
    nextRunAt: now + 900_000,
    prompt: "check the build",
  });
  assert.equal(parseOnceCommand("5m :: check the build", now).prompt, "check the build");

  const evening = parseOnceCommand("at 8p check in on this", now);
  assert.equal(evening.prompt, "check in on this", "a leading time must not eat the prompt's own 'in'");
  assert.equal(new Date(evening.nextRunAt).getHours(), 20);
});

test("/once falls back to a trailing time when the prompt comes first", () => {
  const now = new Date(2026, 7, 22, 8, 30).getTime();

  assert.deepEqual(parseOnceCommand("check the build in 15m", now), {
    nextRunAt: now + 900_000,
    prompt: "check the build",
  });

  const trailing = parseOnceCommand("remind me about the PR at 9:15", now);
  assert.equal(trailing.prompt, "remind me about the PR");
  assert.equal(new Date(trailing.nextRunAt).getHours(), 9);
  assert.equal(new Date(trailing.nextRunAt).getMinutes(), 15);
});

test("/once rejects input with no usable time", () => {
  assert.equal(parseOnceCommand(""), undefined);
  assert.equal(parseOnceCommand("check the build"), undefined);
  assert.equal(parseOnceCommand("15m"), undefined, "a time with no prompt");
});

test("parseScheduleSpec understands every schedule form the same way twice", () => {
  const now = new Date(2026, 7, 22, 8, 30).getTime();

  const every = parseScheduleSpec("every 2h :: ping", now);
  assert.deepEqual(every.schedule, { kind: "interval", intervalMs: 7_200_000 });
  assert.equal(every.prompt, "ping");
  assert.equal(every.nextRunAt, now + 7_200_000);

  const hourly = parseScheduleSpec("hourly check status", now);
  assert.equal(hourly.schedule.intervalMs, 3_600_000);
  assert.equal(hourly.prompt, "check status");

  const daily = parseScheduleSpec("daily 3:30p check grades", now);
  assert.deepEqual(daily.schedule, { kind: "daily", dailyAt: "15:30" });
  assert.equal(new Date(daily.nextRunAt).getHours(), 15);

  const cron = parseScheduleSpec("cron 30 15 * * 1-5 check grades", now);
  assert.equal(cron.schedule.cronExpr, "30 15 * * 1-5");
  assert.equal(new Date(cron.nextRunAt).getDay(), 1, "2026-08-22 is a Saturday, so Monday is next");

  const once = parseScheduleSpec("once 8p check in", now);
  assert.deepEqual(once.schedule, { kind: "once" });
  assert.equal(new Date(once.nextRunAt).getHours(), 20);
});

test("parseScheduleSpec reports why it refused instead of guessing", () => {
  assert.match(parseScheduleSpec("every 10s ping").error, /at least 1m/);
  assert.match(parseScheduleSpec("daily 25:00 ping").error, /Daily syntax/);
  assert.match(parseScheduleSpec("cron 99 * * * * ping").error, /Cron syntax/);
  assert.match(parseScheduleSpec("cron 0 0 30 2 * ping").error, /never matches/);
  assert.match(parseScheduleSpec("once tomorrow ping").error, /Once syntax/);
  assert.match(parseScheduleSpec("weekly ping").error, /Unrecognized schedule/);
  assert.match(parseScheduleSpec("daily 9a").error, /Daily syntax/);
});

test("schedules describe themselves the same way in every surface", () => {
  assert.equal(describeSchedule({ kind: "interval", intervalMs: 5_400_000 }), "every 1h30m");
  assert.equal(describeSchedule({ kind: "daily", dailyAt: "15:30" }), "daily 15:30");
  assert.equal(describeSchedule({ kind: "cron", cronExpr: "@daily" }), "cron @daily");
  assert.equal(describeSchedule({ kind: "once" }), "once");
});

test("durations format back into the same shorthand they parse from", () => {
  assert.equal(formatDuration(5_400_000), "1h30m");
  assert.equal(formatDuration(parseDuration("2d4h5m6s")), "2d4h5m6s");
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(-1), "0ms", "a schedule that just passed is not negative time");
});

test("a cron expression eaten by the shell says so, rather than just 'bad syntax'", () => {
  // What `cron 30 15 * * 1-5 :: x` becomes when the shell expands the stars
  // against the current directory. The fields are real words, so the only clue
  // is that the asterisks are gone.
  const globbed = parseScheduleSpec("cron 30 15 Documents Downloads 1-5 :: check grades");
  assert.match(globbed.error, /shell probably expanded it/);
  assert.match(globbed.error, /'cron 30 15 \* \* 1-5'/, "shows the quoted form to copy");

  // A genuinely malformed expression that still has stars gets the plain
  // message; blaming the shell there would be a wrong guess.
  const wrong = parseScheduleSpec("cron 99 * * * :: check grades");
  assert.match(wrong.error, /Cron syntax/);
  assert.doesNotMatch(wrong.error, /shell/);
});
