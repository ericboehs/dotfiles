/**
 * Schedule parsing and next-occurrence maths, shared by the two schedulers.
 *
 * Nothing here touches pi, the filesystem, or the clock beyond an injectable
 * `now`, because it runs in three places: inside a pi session
 * (session-scheduler.ts), inside the /schedule command (durable-scheduler.ts),
 * and inside the headless runner that a LaunchAgent wakes every minute
 * (bin/pi-scheduler). Keep it dependency-free and pure so all three agree.
 *
 * This directory is deliberately named `lib` with no `index.ts`: pi
 * auto-discovers `extensions/<name>.ts` and `extensions/<name>/index.ts`, so
 * `extensions/lib/` is importable by extensions without being loaded as one.
 */

export const MIN_INTERVAL_MS = 60_000;

export type ScheduleKind = "interval" | "daily" | "once" | "cron";

export interface Schedule {
  kind: ScheduleKind;
  intervalMs?: number;
  dailyAt?: string;
  cronExpr?: string;
}

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseDuration(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  const parts = [...normalized.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== normalized) {
    return undefined;
  }

  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const total = parts.reduce((sum, part) => {
    const amount = Number(part[1]);
    const unit = part[2];
    return sum + amount * (unit ? multipliers[unit] ?? 0 : 0);
  }, 0);

  return Number.isFinite(total) && total > 0 ? Math.round(total) : undefined;
}

export function parseClock(value: string): string | undefined {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(a|am|p|pm)?$/);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3];
  if (minute > 59) return undefined;

  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem.startsWith("p") && hour !== 12) hour += 12;
    if (meridiem.startsWith("a") && hour === 12) hour = 0;
  } else if (hour > 23) {
    return undefined;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function resolveCronValue(token: string | undefined, names?: Record<string, number>): number | undefined {
  if (token === undefined) return undefined;
  const text = token.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  return names ? names[text] : undefined;
}

function parseCronField(
  spec: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): Set<number> | undefined {
  const values = new Set<number>();

  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) return undefined;

    const segments = piece.split("/");
    if (segments.length > 2) return undefined;
    const rangeText = segments[0];
    const stepText = segments[1];
    if (rangeText === undefined) return undefined;

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return undefined;
      step = Number(stepText);
      if (step < 1) return undefined;
    }

    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = min;
      high = max;
    } else {
      const bounds = rangeText.split("-");
      if (bounds.length > 2) return undefined;
      const first = resolveCronValue(bounds[0], names);
      if (first === undefined) return undefined;
      if (bounds.length === 1) {
        low = first;
        high = stepText === undefined ? first : max;
      } else {
        const second = resolveCronValue(bounds[1], names);
        if (second === undefined) return undefined;
        low = first;
        high = second;
      }
    }

    if (low < min || high > max || low > high) return undefined;
    for (let value = low; value <= high; value += step) values.add(value);
  }

  return values.size > 0 ? values : undefined;
}

export function parseCron(expr: string): CronFields | undefined {
  const trimmed = expr.trim().toLowerCase();
  if (!trimmed) return undefined;
  const expanded = trimmed.startsWith("@") ? CRON_MACROS[trimmed] : trimmed;
  if (!expanded) return undefined;

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return undefined;

  const minute = parseCronField(parts[0] ?? "", 0, 59);
  const hour = parseCronField(parts[1] ?? "", 0, 23);
  const dom = parseCronField(parts[2] ?? "", 1, 31);
  const month = parseCronField(parts[3] ?? "", 1, 12, MONTH_NAMES);
  const dowRaw = parseCronField(parts[4] ?? "", 0, 7, DOW_NAMES);
  if (!minute || !hour || !dom || !month || !dowRaw) return undefined;

  return {
    minute,
    hour,
    dom,
    month,
    dow: new Set([...dowRaw].map((value) => (value === 7 ? 0 : value))),
    domRestricted: (parts[2] ?? "*") !== "*",
    dowRestricted: (parts[4] ?? "*") !== "*",
  };
}

function cronDayMatches(date: Date, fields: CronFields): boolean {
  const domOk = fields.dom.has(date.getDate());
  const dowOk = fields.dow.has(date.getDay());
  return fields.domRestricted && fields.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

function nextInSet(values: Set<number>, current: number): number | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (value > current && (best === undefined || value < best)) best = value;
  }
  return best;
}

export function nextCronRun(fields: CronFields, from: Date = new Date()): number | undefined {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let guard = 0; guard < 20_000; guard += 1) {
    if (!fields.month.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cronDayMatches(cursor, fields)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(cursor.getHours())) {
      const hour = nextInSet(fields.hour, cursor.getHours());
      if (hour === undefined) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      } else {
        cursor.setHours(hour, 0, 0, 0);
      }
      continue;
    }
    if (!fields.minute.has(cursor.getMinutes())) {
      const minute = nextInSet(fields.minute, cursor.getMinutes());
      if (minute === undefined) cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      else cursor.setMinutes(minute, 0, 0);
      continue;
    }
    return cursor.getTime();
  }

  return undefined;
}

export function nextDailyRun(dailyAt: string, now = new Date()): number {
  const [hourText, minuteText] = dailyAt.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * The next occurrence strictly after `now`, given that the schedule was last
 * due at `previousRunAt`.
 *
 * Intervals keep their original phase — a 15m loop that was due at :02 stays on
 * :17/:32 even if the process was asleep until :40 — rather than restarting the
 * clock from now. Missed slots are skipped, never replayed. Returns undefined
 * for one-shots and for expressions that can no longer match.
 */
export function advanceSchedule(
  schedule: Schedule,
  previousRunAt: number,
  now: number,
): number | undefined {
  if (schedule.kind === "interval" && schedule.intervalMs) {
    const elapsed = Math.max(0, now - previousRunAt);
    const steps = Math.floor(elapsed / schedule.intervalMs) + 1;
    return previousRunAt + steps * schedule.intervalMs;
  }
  if (schedule.kind === "daily" && schedule.dailyAt) {
    return nextDailyRun(schedule.dailyAt, new Date(now));
  }
  if (schedule.kind === "cron" && schedule.cronExpr) {
    const fields = parseCron(schedule.cronExpr);
    return fields ? nextCronRun(fields, new Date(now)) : undefined;
  }
  return undefined;
}

/** The first occurrence of a freshly created schedule. */
export function firstRunAfter(schedule: Schedule, now = Date.now()): number | undefined {
  if (schedule.kind === "interval" && schedule.intervalMs) return now + schedule.intervalMs;
  if (schedule.kind === "daily" && schedule.dailyAt) return nextDailyRun(schedule.dailyAt, new Date(now));
  if (schedule.kind === "cron" && schedule.cronExpr) {
    const fields = parseCron(schedule.cronExpr);
    return fields ? nextCronRun(fields, new Date(now)) : undefined;
  }
  return undefined;
}

export function parseOnceTime(value: string, now = Date.now()): number | undefined {
  const duration = parseDuration(value);
  if (duration !== undefined) return now + duration;

  const clock = parseClock(value);
  if (clock) return nextDailyRun(clock, new Date(now));

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : undefined;
}

export function stripPromptDelimiter(value: string): string {
  return value.trim().replace(/^::\s*/, "").trim();
}

/**
 * `/once` is deliberately loose about where the time goes, because both
 * readings are natural in English: "in 15m check the build" and "check the
 * build in 15m". The leading form wins when its first token parses as a time,
 * so `/once 8p check in on this` keeps "check in on this" intact instead of
 * being re-read as a trailing "in on this".
 */
export function parseOnceCommand(
  input: string,
  now = Date.now(),
): { nextRunAt: number; prompt: string } | undefined {
  const text = input.trim();
  if (!text) return undefined;

  const candidates: Array<[string, string]> = [];
  const leading = text.match(/^(?:(?:in|at|on)\s+)?(\S+)\s+([\s\S]+)$/i);
  if (leading?.[1] && leading[2]) candidates.push([leading[1], leading[2]]);
  const trailing = text.match(/^([\s\S]+?)\s+(?:in|at|on)\s+(\S+)$/i);
  if (trailing?.[1] && trailing[2]) candidates.push([trailing[2], trailing[1]]);

  for (const [when, promptText] of candidates) {
    const nextRunAt = parseOnceTime(when, now);
    const prompt = stripPromptDelimiter(promptText);
    if (nextRunAt !== undefined && prompt) return { nextRunAt, prompt };
  }
  return undefined;
}

export function formatDuration(milliseconds: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  let remaining = Math.max(0, milliseconds);
  const output: string[] = [];
  for (const [size, suffix] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      output.push(`${count}${suffix}`);
      remaining -= count * size;
    }
  }
  return output.join("") || `${Math.max(0, milliseconds)}ms`;
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") return `every ${formatDuration(schedule.intervalMs ?? 0)}`;
  if (schedule.kind === "daily") return `daily ${schedule.dailyAt}`;
  if (schedule.kind === "cron") return `cron ${schedule.cronExpr}`;
  return "once";
}

/**
 * Turn `every 15m` / `hourly` / `daily 9a` / `cron 0 9 * * 1-5` / `once 8p`
 * plus the trailing prompt into a schedule. Shared so `/schedule` means the
 * same thing in a session and on the command line.
 *
 * Dispatch is on the leading keyword rather than on whether the whole line
 * matches, so a recognized-but-malformed schedule reports that keyword's own
 * syntax instead of the useless "unrecognized".
 */
export function parseScheduleSpec(
  input: string,
  now = Date.now(),
): { schedule: Schedule; prompt: string; nextRunAt: number } | { error: string } {
  const text = input.trim();
  const keyword = (text.split(/\s+/)[0] ?? "").toLowerCase();

  if (keyword === "hourly" || keyword === "every") {
    const hourly = text.match(/^hourly\s+([\s\S]+)$/i);
    const every = text.match(/^every\s+(\S+)\s+([\s\S]+)$/i);
    if (!hourly && !every) {
      return {
        error: keyword === "hourly"
          ? "Hourly syntax: hourly <prompt>"
          : "Interval syntax: every <duration> <prompt>",
      };
    }
    const intervalMs = parseDuration(hourly ? "1h" : (every?.[1] ?? ""));
    if (intervalMs === undefined || intervalMs < MIN_INTERVAL_MS) {
      return { error: "Recurring intervals must be at least 1m (examples: 5m, 1h, 1h30m)" };
    }
    const prompt = stripPromptDelimiter(hourly?.[1] ?? every?.[2] ?? "");
    if (!prompt) return { error: "A prompt is required" };
    return { schedule: { kind: "interval", intervalMs }, prompt, nextRunAt: now + intervalMs };
  }

  if (keyword === "daily") {
    const daily = text.match(/^daily\s+(\S+)\s+([\s\S]+)$/i);
    const dailyAt = daily?.[1] ? parseClock(daily[1]) : undefined;
    const prompt = stripPromptDelimiter(daily?.[2] ?? "");
    if (!dailyAt || !prompt) return { error: "Daily syntax: daily <HH:MM|9a> <prompt>" };
    return {
      schedule: { kind: "daily", dailyAt },
      prompt,
      nextRunAt: nextDailyRun(dailyAt, new Date(now)),
    };
  }

  if (keyword === "cron") {
    const cron = text.match(/^cron\s+(@\w+|(?:\S+\s+){4}\S+)\s+([\s\S]+)$/i);
    const cronExpr = cron?.[1]?.trim().replace(/\s+/g, " ").toLowerCase();
    const fields = cronExpr ? parseCron(cronExpr) : undefined;
    const prompt = stripPromptDelimiter(cron?.[2] ?? "");
    if (!cronExpr || !fields || !prompt) {
      // An unquoted cron expression is the likeliest cause: the shell expands
      // `* *` into filenames before the scheduler ever sees it, so the fields
      // arrive as a list of directory entries.
      const looksGlobbed = /^cron\s/i.test(text) && !/[*@]/.test(text);
      return {
        error: looksGlobbed
          ? "Cron syntax: cron <m h dom mon dow> <prompt>. No * in that expression — the shell probably expanded it; quote the schedule: 'cron 30 15 * * 1-5'"
          : "Cron syntax: cron <m h dom mon dow> <prompt>, or an @macro",
      };
    }
    const nextRunAt = nextCronRun(fields, new Date(now));
    if (nextRunAt === undefined) return { error: `Cron expression ${cronExpr} never matches a real date` };
    return { schedule: { kind: "cron", cronExpr }, prompt, nextRunAt };
  }

  if (keyword === "once") {
    const once = text.match(/^once\s+([\s\S]+)$/i);
    const parsed = once?.[1] ? parseOnceCommand(once[1], now) : undefined;
    if (!parsed) return { error: "Once syntax: once <duration|HH:MM|ISO> <prompt>" };
    return { schedule: { kind: "once" }, prompt: parsed.prompt, nextRunAt: parsed.nextRunAt };
  }

  return { error: `Unrecognized schedule: ${keyword || "(empty)"}` };
}
