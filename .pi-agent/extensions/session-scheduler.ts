import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

import {
  MIN_INTERVAL_MS,
  type Schedule,
  type ScheduleKind,
  advanceSchedule,
  describeSchedule,
  formatDuration,
  parseClock,
  parseCron,
  parseDuration,
  parseOnceCommand,
  stripPromptDelimiter,
} from "./lib/schedule-core.ts";

const SNAPSHOT_TYPE = "session-scheduler:snapshot";
const SNAPSHOT_VERSION = 1;
const MAX_TASKS = 50;

// setTimeout silently fires immediately past this, so long waits are re-armed
// in chunks instead of being trusted to a single timer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type NoticeLevel = "info" | "warning" | "error";

export interface ScheduledTask extends Schedule {
  id: string;
  prompt: string;
  createdAt: number;
  nextRunAt: number;
  paused?: boolean;
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

export function advanceRecurringTask(task: ScheduledTask, now: number): ScheduledTask {
  const next = advanceSchedule(task, task.nextRunAt, now);
  return next === undefined ? task : { ...task, nextRunAt: next };
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

const KINDS: ScheduleKind[] = ["interval", "daily", "once", "cron"];

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<ScheduledTask>;
  if (
    typeof task.id !== "string" ||
    !KINDS.includes(task.kind as ScheduleKind) ||
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

function formatTask(task: ScheduledTask): string {
  const when = new Date(task.nextRunAt).toLocaleString();
  if (task.kind === "once") {
    return `${task.id} · once ${task.paused ? `paused, was ${when}` : when} · ${task.prompt}`;
  }
  const next = task.paused ? "paused" : `next ${when}`;
  return `${task.id} · ${describeSchedule(task)} · ${next} · ${task.prompt}`;
}

function makeTaskId(existing: ScheduledTask[]): string {
  const used = new Set(existing.map((task) => task.id));
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (used.has(id));
  return id;
}

/**
 * Session-scoped timers: `/once` and `/loop`.
 *
 * These live and die with the pi process and the conversation that created
 * them — they fire into the current session, using its model and context, and
 * missed fires are dropped rather than replayed. Anything that must run
 * whether or not pi is open belongs to `/schedule` (durable-scheduler.ts).
 */
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

  const addOnce = (ctx: ExtensionContext, nextRunAt: number, prompt: string) => {
    const task = addTask(ctx, { kind: "once", prompt, nextRunAt });
    notice(
      ctx,
      `Scheduled ${task.id} once at ${new Date(task.nextRunAt).toLocaleString()}`
      + ` (in ${formatDuration(task.nextRunAt - Date.now())});`
      + " keep this session open or it will not fire.",
    );
    return task;
  };

  const findTask = (idPrefix: string) => {
    const matches = tasks.filter((task) => task.id.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`No session task matches ${idPrefix}`);
    if (matches.length > 1) throw new Error(`Task prefix ${idPrefix} is ambiguous`);
    const task = matches[0];
    if (!task) throw new Error(`No session task matches ${idPrefix}`);
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
        "Session timers (this session only, while pi is running):",
        "  /once <duration|HH:MM|ISO> <prompt>",
        "  /once <prompt> in <duration>",
        "  /once list | cancel <id>",
        "  /loop <duration> <prompt>",
        "  /loop <prompt> every <duration>",
        "  /loop list | cancel <id> | clear",
        "  /loop pause <id|all> | resume <id|all>",
        "  (:: before the prompt is optional)",
        "/once help or /loop help explains the forms in full.",
        "Use /schedule for tasks that must run without an open session.",
      ].join("\n"),
      "warning",
    );
  };

  const showHelp = (ctx: ExtensionContext) => {
    notice(
      ctx,
      [
        "/once and /loop \u2014 timers that fire a prompt into this conversation.",
        "",
        "They live in this session: they need pi open, they stop when it exits, and",
        "anything missed while it was closed is dropped rather than replayed. For work",
        "that must happen whether or not you are here, use /schedule.",
        "",
        "/once \u2014 fire one time",
        "  /once 15m check whether the deploy finished",
        "  /once at 8p check in on this",
        "  /once remind me about the PR in 2h",
        "  The time may lead or trail. A leading time wins when it parses, so",
        "  '/once 8p check in on this' keeps the prompt's own 'in'.",
        "",
        "/loop \u2014 fire repeatedly (1m minimum)",
        "  /loop 15m check CI",
        "  /loop review the deploy every 1h",
        "",
        "TIMES   /once takes 30s 15m 2h 1d, or 9a 8p 15:30, or an ISO timestamp",
        "        /loop takes a duration only, 1m or longer",
        "",
        "MANAGING",
        "  /once list | cancel <id>              one-shots only",
        "  /loop list | cancel <id> | clear      every timer in this session",
        "  /loop pause <id|all> | resume <id|all>",
        "  pause keeps a task but disarms it; resume moves to the next future slot",
        "  rather than firing for everything missed while it was paused.",
        "",
        "Timers restore when you resume this session, and are not inherited by /new,",
        "/fork or /clone. (:: before the prompt is optional.)",
      ].join("\n"),
      "info",
    );
  };

  /** `list`, `cancel`, `pause`, `resume`, `clear` — shared by /once and /loop. */
  const handleManagement = async (
    input: string,
    ctx: ExtensionContext,
    { onlyOnce }: { onlyOnce: boolean },
  ): Promise<boolean> => {
    if (/^(list|ls)$/i.test(input)) {
      const listed = onlyOnce ? tasks.filter((task) => task.kind === "once") : tasks;
      notice(
        ctx,
        listed.length > 0
          ? listed.map(formatTask).join("\n")
          : onlyOnce
            ? "No one-shot tasks in this session"
            : "No timers in this session",
      );
      return true;
    }

    const cancel = input.match(/^(?:cancel|delete|remove|stop)\s+(\S+)$/i);
    if (cancel?.[1]) {
      try {
        const task = removeTask(ctx, cancel[1]);
        notice(ctx, `Cancelled session task ${task.id}`);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (onlyOnce) return false;

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
      return true;
    }

    const clear = input.match(/^clear(?:\s+(yes))?$/i);
    if (clear) {
      const confirmed = clear[1] === "yes"
        || (ctx.hasUI && await ctx.ui.confirm("Clear session timers?", `Cancel all ${tasks.length} task(s) in this session?`));
      if (!confirmed) {
        notice(ctx, ctx.hasUI ? "No timers changed" : "Use /loop clear yes in non-interactive mode", "warning");
        return true;
      }
      clearRuntime();
      tasks = [];
      persist();
      updateStatus(ctx);
      notice(ctx, "Cleared all session timers");
      return true;
    }

    return false;
  };

  pi.registerCommand("once", {
    description: "Run a prompt once later in this session, for example /once 15m check the build",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "help") {
        showHelp(ctx);
        return;
      }
      if (await handleManagement(input, ctx, { onlyOnce: true })) return;

      const parsed = parseOnceCommand(input);
      if (!parsed) {
        showUsage(ctx);
        return;
      }
      try {
        addOnce(ctx, parsed.nextRunAt, parsed.prompt);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("loop", {
    description: "Repeat a prompt in this session, for example /loop 5m check the deploy",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "help") {
        showHelp(ctx);
        return;
      }
      if (!input) {
        showUsage(ctx);
        return;
      }
      if (await handleManagement(input, ctx, { onlyOnce: false })) return;

      const leading = input.match(/^(?:every\s+)?(\S+)\s+([\s\S]+)$/i);
      const trailing = input.match(/^([\s\S]+?)\s+every\s+(\S+)\s*$/i);
      const duration = trailing?.[2] ?? leading?.[1];
      const prompt = trailing?.[1] ?? leading?.[2];
      if (!duration || !prompt) {
        showUsage(ctx);
        return;
      }
      try {
        const task = addInterval(ctx, duration, prompt);
        notice(ctx, `Looping ${task.id} every ${formatDuration(task.intervalMs ?? 0)}; next ${new Date(task.nextRunAt).toLocaleString()}`);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
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
