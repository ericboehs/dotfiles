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

type ScheduleKind = "interval" | "daily" | "once";
type NoticeLevel = "info" | "warning" | "error";

export interface ScheduledTask {
  id: string;
  kind: ScheduleKind;
  prompt: string;
  createdAt: number;
  nextRunAt: number;
  intervalMs?: number;
  dailyAt?: string;
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
  return task;
}

export function normalizeTasksForResume(
  tasks: ScheduledTask[],
  now = Date.now(),
): ResumeResult {
  const normalized: ScheduledTask[] = [];
  let changed = false;

  for (const task of tasks) {
    if (task.kind === "once") {
      if (task.nextRunAt <= now) {
        changed = true;
        continue;
      }
      normalized.push(task);
      continue;
    }

    if (task.nextRunAt <= now) {
      normalized.push(advanceRecurringTask(task, now));
      changed = true;
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
  if (task.kind === "interval") {
    return `${task.id} · every ${formatDuration(task.intervalMs ?? 0)} · next ${when} · ${task.prompt}`;
  }
  if (task.kind === "daily") return `${task.id} · daily ${task.dailyAt} · next ${when} · ${task.prompt}`;
  return `${task.id} · once ${when} · ${task.prompt}`;
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
    const count = new Set([...tasks.map((task) => task.id), ...pending.keys()]).size;
    ctx.ui.setStatus("session-scheduler", count > 0 ? `⏰ ${count}` : undefined);
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
        tasks[index] = advanced;
        armTask(advanced, ctx, runtimeGeneration);
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
    for (const task of tasks) armTask(task, ctx, runtimeGeneration);
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
    armTask(complete, ctx, generation);
    updateStatus(ctx);
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

  const removeTask = (ctx: ExtensionContext, idPrefix: string) => {
    const matches = tasks.filter((task) => task.id.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`No scheduled task matches ${idPrefix}`);
    if (matches.length > 1) throw new Error(`Task prefix ${idPrefix} is ambiguous`);
    const task = matches[0];
    if (!task) throw new Error(`No scheduled task matches ${idPrefix}`);

    tasks = tasks.filter((candidate) => candidate.id !== task.id);
    pending.delete(task.id);
    const timer = timers.get(task.id);
    if (timer) clearTimeout(timer);
    timers.delete(task.id);
    persist();
    updateStatus(ctx);
    return task;
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
        "  /schedule once <duration|HH:MM|ISO> <prompt>",
        "  /schedule list | cancel <id> | clear",
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
