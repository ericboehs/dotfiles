import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

const SNAPSHOT_TYPE = "session-scheduler:snapshot";
const SNAPSHOT_VERSION = 1;
const MAX_TASKS = 50;
const MIN_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type ScheduleKind = "interval" | "daily" | "once" | "cron";
type NoticeLevel = "info" | "warning" | "error";

export interface ScheduledTask {
  id: string;
  kind: ScheduleKind;
  prompt: string;
  createdAt: number;
  nextRunAt: number;
  intervalMs?: number;
  dailyAt?: string;
  cronExpr?: string;
  paused?: boolean;
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

interface SchedulerSnapshot {
  version: number;
  sessionId: string;
  tasks: ScheduledTask[];
}

interface ResumeResult {
  tasks: ScheduledTask[];
  changed: boolean;
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

export function advanceRecurringTask(task: ScheduledTask, now: number): ScheduledTask {
  if (task.kind === "interval" && task.intervalMs) {
    const elapsed = Math.max(0, now - task.nextRunAt);
    const steps = Math.floor(elapsed / task.intervalMs) + 1;
    return { ...task, nextRunAt: task.nextRunAt + steps * task.intervalMs };
  }
  if (task.kind === "daily" && task.dailyAt) {
    return { ...task, nextRunAt: nextDailyRun(task.dailyAt, new Date(now)) };
  }
  if (task.kind === "cron" && task.cronExpr) {
    const fields = parseCron(task.cronExpr);
    const next = fields ? nextCronRun(fields, new Date(now)) : undefined;
    return next === undefined ? task : { ...task, nextRunAt: next };
  }
  return task;
}

export function normalizeTasksForResume(
  tasks: ScheduledTask[],
  now = Date.now(),
): ResumeResult {
  const normalized: ScheduledTask[] = [];
  let changed = false;

  for (const task of tasks) {
    if (task.paused) {
      normalized.push(task);
      continue;
    }
    if (task.kind === "once") {
      if (task.nextRunAt <= now) {
        changed = true;
        continue;
      }
      normalized.push(task);
      continue;
    }

    if (task.nextRunAt <= now) {
      const advanced = advanceRecurringTask(task, now);
      changed = true;
      if (advanced.nextRunAt > now) normalized.push(advanced);
    } else {
      normalized.push(task);
    }
  }

  return { tasks: normalized, changed };
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<ScheduledTask>;
  if (
    typeof task.id !== "string" ||
    !["interval", "daily", "once"].includes(task.kind ?? "") ||
    typeof task.prompt !== "string" ||
    !task.prompt.trim() ||
    typeof task.createdAt !== "number" ||
    typeof task.nextRunAt !== "number"
  ) {
    return false;
  }
  if (task.kind === "interval") {
    return typeof task.intervalMs === "number" && task.intervalMs >= MIN_INTERVAL_MS;
  }
  if (task.kind === "daily") return typeof task.dailyAt === "string" && parseClock(task.dailyAt) !== undefined;
  if (task.kind === "cron") return typeof task.cronExpr === "string" && parseCron(task.cronExpr) !== undefined;
  return true;
}

function readSnapshot(ctx: ExtensionContext): ScheduledTask[] {
  const sessionId = ctx.sessionManager.getSessionId();
  const branch = ctx.sessionManager.getBranch();

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;

    const snapshot = entry.data as Partial<SchedulerSnapshot>;
    if (
      snapshot.version !== SNAPSHOT_VERSION ||
      snapshot.sessionId !== sessionId ||
      !Array.isArray(snapshot.tasks)
    ) {
      continue;
    }
    return snapshot.tasks.filter(isScheduledTask).map((task) => ({ ...task }));
  }

  return [];
}

function sessionHasAssistantMessage(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => {
    const candidate = entry as { type?: unknown; message?: { role?: unknown } };
    return candidate.type === "message" && candidate.message?.role === "assistant";
  });
}

function parseOnceTime(value: string, now = Date.now()): number | undefined {
  const duration = parseDuration(value);
  if (duration !== undefined) return now + duration;

  const clock = parseClock(value);
  if (clock) return nextDailyRun(clock, new Date(now));

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : undefined;
}

function stripPromptDelimiter(value: string): string {
  return value.trim().replace(/^::\s*/, "").trim();
}

function formatDuration(milliseconds: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  let remaining = milliseconds;
  const output: string[] = [];
  for (const [size, suffix] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      output.push(`${count}${suffix}`);
      remaining -= count * size;
    }
  }
  return output.join("") || `${milliseconds}ms`;
}

function formatTask(task: ScheduledTask): string {
  const when = new Date(task.nextRunAt).toLocaleString();
  const next = task.paused ? "paused" : `next ${when}`;
  if (task.kind === "interval") {
    return `${task.id} · every ${formatDuration(task.intervalMs ?? 0)} · ${next} · ${task.prompt}`;
  }
  if (task.kind === "daily") return `${task.id} · daily ${task.dailyAt} · ${next} · ${task.prompt}`;
  if (task.kind === "cron") return `${task.id} · cron ${task.cronExpr} · ${next} · ${task.prompt}`;
  return `${task.id} · once ${task.paused ? `paused, was ${when}` : when} · ${task.prompt}`;
}

function makeTaskId(existing: ScheduledTask[]): string {
  const used = new Set(existing.map((task) => task.id));
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (used.has(id));
  return id;
}

export default function sessionScheduler(pi: ExtensionAPI): void {
  let tasks: ScheduledTask[] = [];
  let activeCtx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let generation = 0;
  let deliveryInFlight = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, ScheduledTask>();

  const notice = (ctx: ExtensionContext, message: string, level: NoticeLevel = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`${message}\n`);
  };

  const updateStatus = (ctx = activeCtx) => {
    if (!ctx?.hasUI) return;
    const active = new Set([
      ...tasks.filter((task) => !task.paused).map((task) => task.id),
      ...pending.keys(),
    ]).size;
    const paused = tasks.filter((task) => task.paused).length;
    const label = active > 0 || paused > 0
      ? `⏰ ${active}${paused > 0 ? ` ⏸${paused}` : ""}`
      : undefined;
    ctx.ui.setStatus("session-scheduler", label);
  };

  const persist = () => {
    if (!sessionId) return;
    pi.appendEntry(SNAPSHOT_TYPE, {
      version: SNAPSHOT_VERSION,
      sessionId,
      tasks: tasks.map((task) => ({ ...task })),
    } satisfies SchedulerSnapshot);
  };

  const clearRuntime = () => {
    generation += 1;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
    deliveryInFlight = false;
  };

  const drainPending = () => {
    const ctx = activeCtx;
    if (!ctx || deliveryInFlight || !ctx.isIdle()) return;
    const next = pending.entries().next().value as [string, ScheduledTask] | undefined;
    if (!next) return;

    const [id, task] = next;
    pending.delete(id);
    if (task.kind === "once") {
      tasks = tasks.filter((candidate) => candidate.id !== task.id);
      persist();
    }
    deliveryInFlight = true;
    updateStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify(`Scheduled task ${task.id} fired`, "info");
    try {
      pi.sendUserMessage(task.prompt);
    } catch (error) {
      deliveryInFlight = false;
      pending.set(id, task);
      notice(ctx, `Could not deliver scheduled task ${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const armTask = (task: ScheduledTask, ctx: ExtensionContext, runtimeGeneration: number) => {
    const existing = timers.get(task.id);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, task.nextRunAt - Date.now());
    const timer = setTimeout(() => {
      timers.delete(task.id);
      if (runtimeGeneration !== generation) return;

      const index = tasks.findIndex((candidate) => candidate.id === task.id);
      if (index < 0) return;
      const current = tasks[index];
      if (!current) return;
      const now = Date.now();
      if (current.nextRunAt > now) {
        armTask(current, ctx, runtimeGeneration);
        return;
      }

      if (!pending.has(current.id)) pending.set(current.id, { ...current });
      if (current.kind !== "once") {
        const advanced = advanceRecurringTask(current, now);
        if (advanced.nextRunAt > now) {
          tasks[index] = advanced;
          armTask(advanced, ctx, runtimeGeneration);
        } else {
          tasks.splice(index, 1);
        }
      }
      persist();
      updateStatus(ctx);
      drainPending();
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    timers.set(task.id, timer);
  };

  const restoreRuntime = (ctx: ExtensionContext) => {
    clearRuntime();
    activeCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    const restored = normalizeTasksForResume(readSnapshot(ctx));
    tasks = restored.tasks;
    const runtimeGeneration = generation;
    for (const task of tasks) {
      if (!task.paused) armTask(task, ctx, runtimeGeneration);
    }
    if (restored.changed) persist();
    updateStatus(ctx);
  };

  const addTask = (ctx: ExtensionContext, task: Omit<ScheduledTask, "id" | "createdAt">) => {
    if (tasks.length >= MAX_TASKS) throw new Error(`This session already has ${MAX_TASKS} scheduled tasks`);
    const complete: ScheduledTask = {
      ...task,
      id: makeTaskId(tasks),
      createdAt: Date.now(),
    };
    tasks.push(complete);
    persist();
    if (!complete.paused) armTask(complete, ctx, generation);
    updateStatus(ctx);
    if (!sessionHasAssistantMessage(ctx)) {
      notice(
        ctx,
        "This session has no model reply yet, so pi has not written it to disk. The schedule is held in memory and saves with the first reply — quit before that and it is lost.",
        "warning",
      );
    }
    return complete;
  };

  const addInterval = (ctx: ExtensionContext, durationText: string, promptText: string) => {
    const intervalMs = parseDuration(durationText);
    if (intervalMs === undefined || intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Recurring intervals must be at least 1m (examples: 5m, 1h, 1h30m)");
    }
    const prompt = stripPromptDelimiter(promptText);
    if (!prompt) throw new Error("A prompt is required");
    return addTask(ctx, {
      kind: "interval",
      prompt,
      intervalMs,
      nextRunAt: Date.now() + intervalMs,
    });
  };

  const findTask = (idPrefix: string) => {
    const matches = tasks.filter((task) => task.id.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`No scheduled task matches ${idPrefix}`);
    if (matches.length > 1) throw new Error(`Task prefix ${idPrefix} is ambiguous`);
    const task = matches[0];
    if (!task) throw new Error(`No scheduled task matches ${idPrefix}`);
    return task;
  };

  const disarm = (id: string) => {
    pending.delete(id);
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  const removeTask = (ctx: ExtensionContext, idPrefix: string) => {
    const task = findTask(idPrefix);
    tasks = tasks.filter((candidate) => candidate.id !== task.id);
    disarm(task.id);
    persist();
    updateStatus(ctx);
    return task;
  };

  const setPaused = (ctx: ExtensionContext, target: string, paused: boolean) => {
    const all = /^(all|\*)$/i.test(target);
    const selected = all ? tasks.filter((task) => Boolean(task.paused) !== paused) : [findTask(target)];
    if (selected.length === 0) {
      return { changed: [] as ScheduledTask[], expired: [] as ScheduledTask[] };
    }

    const now = Date.now();
    const changed: ScheduledTask[] = [];
    const expired: ScheduledTask[] = [];

    for (const task of selected) {
      if (paused) {
        disarm(task.id);
        const updated = { ...task, paused: true };
        tasks = tasks.map((candidate) => (candidate.id === task.id ? updated : candidate));
        changed.push(updated);
        continue;
      }

      const revived = normalizeTasksForResume([{ ...task, paused: false }], now).tasks[0];
      if (!revived) {
        tasks = tasks.filter((candidate) => candidate.id !== task.id);
        expired.push(task);
        continue;
      }
      tasks = tasks.map((candidate) => (candidate.id === task.id ? revived : candidate));
      armTask(revived, ctx, generation);
      changed.push(revived);
    }

    persist();
    updateStatus(ctx);
    return { changed, expired };
  };

  const showUsage = (ctx: ExtensionContext) => {
    notice(
      ctx,
      [
        "Session scheduler:",
        "  /loop <duration> <prompt>",
        "  /schedule every <duration> <prompt>",
        "  /schedule hourly <prompt>",
        "  /schedule daily <HH:MM|9a> <prompt>",
        "  /schedule cron <m h dom mon dow|@daily> <prompt>",
        "  /schedule once <duration|HH:MM|ISO> <prompt>",
        "  /schedule list | cancel <id> | clear",
        "  /schedule pause <id|all> | resume <id|all>",
        "  (:: before the prompt is optional)",
      ].join("\n"),
      "warning",
    );
  };

  pi.registerCommand("loop", {
    description: "Repeat a prompt in this session, for example /loop 5m check the deploy",
    handler: async (args, ctx) => {
      const leading = args.match(/^\s*(?:every\s+)?(\S+)\s+([\s\S]+)$/i);
      const trailing = args.match(/^\s*([\s\S]+?)\s+every\s+(\S+)\s*$/i);
      const duration = trailing?.[2] ?? leading?.[1];
      const prompt = trailing?.[1] ?? leading?.[2];
      if (!duration || !prompt) {
        showUsage(ctx);
        return;
      }
      try {
        const task = addInterval(ctx, duration, prompt);
        notice(ctx, `Scheduled ${task.id} every ${formatDuration(task.intervalMs ?? 0)}; next ${new Date(task.nextRunAt).toLocaleString()}`);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("schedule", {
    description: "Manage session-only hourly, daily, interval, and one-shot prompts",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input || input === "help") {
        showUsage(ctx);
        return;
      }

      if (/^(list|ls)$/i.test(input)) {
        notice(ctx, tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No scheduled tasks in this session");
        return;
      }

      const toggle = input.match(/^(pause|resume|unpause)\s+(\S+)$/i);
      if (toggle?.[1] && toggle[2]) {
        const paused = toggle[1].toLowerCase() === "pause";
        try {
          const { changed, expired } = setPaused(ctx, toggle[2], paused);
          const lines: string[] = [];
          if (changed.length > 0) {
            lines.push(
              paused
                ? `Paused ${changed.length} task(s): ${changed.map((task) => task.id).join(", ")}`
                : changed.map((task) => `Resumed ${task.id}; next ${new Date(task.nextRunAt).toLocaleString()}`).join("\n"),
            );
          }
          for (const task of expired) {
            lines.push(`Dropped ${task.id}: its one-shot time passed while paused`);
          }
          if (lines.length === 0) lines.push(paused ? "Nothing to pause" : "Nothing to resume");
          notice(ctx, lines.join("\n"), expired.length > 0 ? "warning" : "info");
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const cancel = input.match(/^(?:cancel|delete|remove)\s+(\S+)$/i);
      if (cancel?.[1]) {
        try {
          const task = removeTask(ctx, cancel[1]);
          notice(ctx, `Cancelled scheduled task ${task.id}`);
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const clear = input.match(/^clear(?:\s+(yes))?$/i);
      if (clear) {
        const confirmed = clear[1] === "yes" || (ctx.hasUI && await ctx.ui.confirm("Clear schedules?", `Cancel all ${tasks.length} task(s) in this session?`));
        if (!confirmed) {
          notice(ctx, ctx.hasUI ? "No schedules changed" : "Use /schedule clear yes in non-interactive mode", "warning");
          return;
        }
        clearRuntime();
        tasks = [];
        persist();
        updateStatus(ctx);
        notice(ctx, "Cleared all scheduled tasks in this session");
        return;
      }

      const hourly = input.match(/^hourly\s+([\s\S]+)$/i);
      if (hourly?.[1]) {
        try {
          const task = addInterval(ctx, "1h", hourly[1]);
          notice(ctx, `Scheduled ${task.id} hourly; next ${new Date(task.nextRunAt).toLocaleString()}`);
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const recurring = input.match(/^every\s+(\S+)\s+([\s\S]+)$/i);
      if (recurring?.[1] && recurring[2]) {
        try {
          const task = addInterval(ctx, recurring[1], recurring[2]);
          notice(ctx, `Scheduled ${task.id} every ${formatDuration(task.intervalMs ?? 0)}; next ${new Date(task.nextRunAt).toLocaleString()}`);
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const daily = input.match(/^daily\s+(\S+)\s+([\s\S]+)$/i);
      if (daily?.[1] && daily[2]) {
        const dailyAt = parseClock(daily[1]);
        const prompt = stripPromptDelimiter(daily[2]);
        if (!dailyAt || !prompt) {
          notice(ctx, "Daily syntax: /schedule daily <HH:MM|9a> <prompt>", "error");
          return;
        }
        try {
          const task = addTask(ctx, {
            kind: "daily",
            dailyAt,
            prompt,
            nextRunAt: nextDailyRun(dailyAt),
          });
          notice(ctx, `Scheduled ${task.id} daily at ${dailyAt}; next ${new Date(task.nextRunAt).toLocaleString()}`);
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const cron = input.match(/^cron\s+(@\w+|(?:\S+\s+){4}\S+)\s+([\s\S]+)$/i);
      if (cron?.[1] && cron[2]) {
        const expr = cron[1].trim().replace(/\s+/g, " ").toLowerCase();
        const fields = parseCron(expr);
        const prompt = stripPromptDelimiter(cron[2]);
        if (!fields || !prompt) {
          notice(ctx, "Cron syntax: /schedule cron <m h dom mon dow> <prompt>, or an @macro", "error");
          return;
        }
        const nextRunAt = nextCronRun(fields);
        if (nextRunAt === undefined) {
          notice(ctx, `Cron expression ${expr} never matches a real date`, "error");
          return;
        }
        try {
          const task = addTask(ctx, { kind: "cron", cronExpr: expr, prompt, nextRunAt });
          notice(ctx, `Scheduled ${task.id} cron ${expr}; next ${new Date(task.nextRunAt).toLocaleString()}`);
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const once = input.match(/^once\s+(\S+)\s+([\s\S]+)$/i);
      if (once?.[1] && once[2]) {
        const nextRunAt = parseOnceTime(once[1]);
        const prompt = stripPromptDelimiter(once[2]);
        if (!nextRunAt || !prompt) {
          notice(ctx, "Once syntax: /schedule once <duration|HH:MM|ISO> <prompt>", "error");
          return;
        }
        try {
          const task = addTask(ctx, { kind: "once", prompt, nextRunAt });
          notice(ctx, `Scheduled ${task.id} once at ${new Date(task.nextRunAt).toLocaleString()}`);
        } catch (error) {
          notice(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      showUsage(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => restoreRuntime(ctx));
  pi.on("session_tree", (_event, ctx) => restoreRuntime(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    deliveryInFlight = false;
    activeCtx = ctx;
    drainPending();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearRuntime();
    if (ctx.hasUI) ctx.ui.setStatus("session-scheduler", undefined);
    activeCtx = undefined;
    sessionId = undefined;
    tasks = [];
  });
}
