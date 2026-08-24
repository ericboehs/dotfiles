/**
 * The durable task registry behind `/schedule`.
 *
 * Sessions are conversation trees appended without file locking, so scheduled
 * work cannot live in them: a headless run and an open TUI would race on the
 * same JSONL. Durable tasks therefore get their own small store, outside any
 * session, that both the `/schedule` command and the headless runner
 * (bin/pi-scheduler) read and write under a lock.
 *
 * Layout, all mode 0700/0600 because prompts and run output routinely contain
 * private data:
 *
 *   ~/.pi/agent/scheduler/
 *     tasks.json          the registry (atomically replaced)
 *     tasks.json.lock/    a mkdir mutex held only across read-modify-write
 *     runs/<id>.jsonl     per-task run history, newest last
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  MIN_INTERVAL_MS,
  type Schedule,
  type ScheduleKind,
  advanceSchedule,
  describeSchedule,
  formatDuration,
  parseClock,
  parseCron,
} from "./schedule-core.ts";

export const REGISTRY_VERSION = 1;
export const MAX_DURABLE_TASKS = 100;

/** Default catch-up window. The Mac sleeps; a 3:30pm task should still run at 4. */
export const DEFAULT_MISFIRE_GRACE_MS = 7_200_000;
export const DEFAULT_TIMEOUT_MS = 900_000;

/** How long a claim may look alive before the runner is presumed dead. */
export const CLAIM_STALE_MS = 6 * 3_600_000;

const LOCK_STALE_MS = 60_000;

export type RunStatus = "ok" | "error" | "timeout" | "skipped";

/**
 * `skip` never runs late, `always` always does, and a number is the grace
 * window in milliseconds past `nextRunAt` within which a late run is still
 * wanted. Late runs coalesce: one catch-up, never a replay of every slot.
 */
/**
 * What this task actually runs with, folding in the legacy `tools` boolean that
 * predates `enable`.
 */
export function enabledFeatures(task: DurableTask): Set<Feature> {
  const features = new Set<Feature>(task.enable ?? []);
  if (task.tools) features.add("tools");
  return features;
}

export type MisfirePolicy = "skip" | "always" | number;

/**
 * Discovery a scheduled run can opt back into.
 *
 * Themes are deliberately absent: a headless run has no TUI to theme, so the
 * flag would be a knob that does nothing.
 */
export const FEATURES = ["extensions", "skills", "templates", "context", "tools"] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * Parse a `--with` list. Returns an error string rather than throwing, so both
 * the slash command and the CLI can report it the same way.
 */
export function parseFeatures(input: string): { features: Feature[] } | { error: string } {
  const requested = input
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (requested.length === 0) return { error: `--with wants ${FEATURES.join(", ")}, or all` };

  const features = new Set<Feature>();
  for (const item of requested) {
    if (item === "all") {
      for (const feature of FEATURES) features.add(feature);
      continue;
    }
    if (item === "none") continue;
    const match = FEATURES.find(
      (feature) => feature === item || `${feature}s` === item || feature === `${item}s`,
    );
    if (!match) {
      return { error: `--with does not know "${item}"; try ${FEATURES.join(", ")}, all or none` };
    }
    features.add(match);
  }
  return { features: FEATURES.filter((feature) => features.has(feature)) };
}

export interface DurableTask extends Schedule {
  id: string;
  name?: string;
  prompt: string;
  /** Model pattern as pi's --model takes it, e.g. "cerebras/gpt-oss-120b:low". */
  model?: string;
  cwd?: string;
  /** Off by default: most scheduled prompts summarize data gathered by `deliver`-style scripts. */
  tools?: boolean;
  /**
   * Discovery to switch back on for this run. Empty means a bare pi, which is
   * reproducible and starts in about a second. Opt in when the prompt needs
   * your setup — a skill, or a prompt template invoked as `/checkin`.
   */
  enable?: Feature[];
  /** Shell command receiving the run output on stdin and in $PI_SCHEDULER_OUTPUT. */
  deliver?: string;
  misfire?: MisfirePolicy;
  timeoutMs?: number;
  paused?: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  /** Set while a runner owns this task, so overlapping minute checks do not double-run it. */
  runningSince?: number;
  runnerPid?: number;
}

export interface Registry {
  version: number;
  tasks: DurableTask[];
}

export interface RunRecord {
  runId: string;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  exitCode?: number;
  scheduledFor?: number;
  error?: string;
  /** Truncated; the point is a glanceable history, not an archive. */
  output?: string;
}

export const MAX_RECORDED_OUTPUT = 4_000;
export const MAX_RUN_LOG_RECORDS = 200;
export const MAX_RUN_LOG_BYTES = 1_000_000;

export function schedulerDir(): string {
  return process.env.PI_SCHEDULER_DIR
    ?? join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "scheduler");
}

export function registryPath(): string {
  return join(schedulerDir(), "tasks.json");
}

function runsPath(taskId: string): string {
  return join(schedulerDir(), "runs", `${taskId}.jsonl`);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Replace a file atomically and privately. The chmod is on the temp file, so
 * the contents are never briefly world-readable under a restrictive umask.
 */
function writePrivateAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function appendPrivate(path: string, line: string): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export function emptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, tasks: [] };
}

const KINDS: ScheduleKind[] = ["interval", "daily", "once", "cron"];

export function isDurableTask(value: unknown): value is DurableTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<DurableTask>;
  if (
    typeof task.id !== "string" ||
    !task.id ||
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
  if (task.kind === "daily") {
    return typeof task.dailyAt === "string" && parseClock(task.dailyAt) !== undefined;
  }
  if (task.kind === "cron") {
    return typeof task.cronExpr === "string" && parseCron(task.cronExpr) !== undefined;
  }
  return true;
}

/**
 * A corrupt or unreadable registry reads as empty rather than throwing: the
 * runner is started by launchd every minute with nobody watching stderr, and a
 * hard failure there is indistinguishable from "no tasks" except that it never
 * recovers. Individual malformed tasks are dropped, not the whole file.
 */
export function readRegistry(): Registry {
  let raw: string;
  try {
    raw = readFileSync(registryPath(), "utf8");
  } catch {
    return emptyRegistry();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRegistry();
  }

  const candidate = parsed as Partial<Registry>;
  if (candidate?.version !== REGISTRY_VERSION || !Array.isArray(candidate.tasks)) {
    return emptyRegistry();
  }
  return { version: REGISTRY_VERSION, tasks: candidate.tasks.filter(isDurableTask) };
}

export function writeRegistry(registry: Registry): void {
  writePrivateAtomic(
    registryPath(),
    `${JSON.stringify({ version: REGISTRY_VERSION, tasks: registry.tasks }, undefined, 2)}\n`,
  );
}

function lockPath(): string {
  return `${registryPath()}.lock`;
}

function lockAgeMs(): number | undefined {
  try {
    return Date.now() - statSync(lockPath()).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Read-modify-write the registry under a mkdir mutex.
 *
 * mkdir is the one filesystem primitive that is atomic on every macOS
 * filesystem including network volumes, and the lock is only ever held for the
 * few milliseconds of a JSON round trip — the actual agent run happens outside
 * it, guarded instead by the claim fields on the task.
 */
export function withRegistry<T>(mutate: (registry: Registry) => T): T {
  ensureDir(schedulerDir());
  const path = lockPath();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = lockAgeMs();
      if (age !== undefined && age > LOCK_STALE_MS) {
        // The holder died mid-write. The registry itself is only ever replaced
        // by rename, so the worst case is a lost concurrent edit, not a torn file.
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }

    try {
      return mutate(readRegistry());
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }

  throw new Error(`Could not lock ${path}; remove it if no scheduler is running`);
}

export function makeTaskId(existing: DurableTask[]): string {
  const used = new Set(existing.map((task) => task.id));
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (used.has(id));
  return id;
}

export function findTasks(tasks: DurableTask[], selector: string): DurableTask[] {
  const needle = selector.toLowerCase();
  const byName = tasks.filter((task) => task.name?.toLowerCase() === needle);
  if (byName.length > 0) return byName;
  return tasks.filter((task) => task.id.startsWith(needle));
}

export function findTask(tasks: DurableTask[], selector: string): DurableTask {
  const matches = findTasks(tasks, selector);
  const task = matches[0];
  if (!task) throw new Error(`No scheduled task matches ${selector}`);
  if (matches.length > 1) throw new Error(`${selector} is ambiguous: ${matches.map((m) => m.id).join(", ")}`);
  return task;
}

export function misfireGraceMs(task: DurableTask): number {
  const policy = task.misfire ?? DEFAULT_MISFIRE_GRACE_MS;
  if (policy === "skip") return 0;
  if (policy === "always") return Number.POSITIVE_INFINITY;
  return typeof policy === "number" && policy >= 0 ? policy : DEFAULT_MISFIRE_GRACE_MS;
}

export function isClaimStale(task: DurableTask, now: number): boolean {
  if (task.runningSince === undefined) return false;
  return now - task.runningSince > (task.timeoutMs ?? DEFAULT_TIMEOUT_MS) + CLAIM_STALE_MS;
}

export interface DueDecision {
  task: DurableTask;
  /** The slot this run belongs to, which is not `now` when catching up. */
  scheduledFor: number;
  /** Late beyond the grace window: advance the schedule, record a skip, run nothing. */
  skip: boolean;
}

/**
 * Which tasks this tick should act on. Pure, so the policy is testable without
 * a filesystem or a clock.
 */
export function selectDue(tasks: DurableTask[], now: number): DueDecision[] {
  const due: DueDecision[] = [];
  for (const task of tasks) {
    if (task.paused) continue;
    if (task.nextRunAt > now) continue;
    if (task.runningSince !== undefined && !isClaimStale(task, now)) continue;
    due.push({
      task,
      scheduledFor: task.nextRunAt,
      skip: now - task.nextRunAt > misfireGraceMs(task),
    });
  }
  return due;
}

/**
 * The task as it should be stored once a run for `scheduledFor` is claimed.
 * One-shots are marked so the caller can delete them after they succeed.
 */
export function claimTask(task: DurableTask, now: number, pid: number): DurableTask {
  return { ...task, runningSince: now, runnerPid: pid };
}

/** Clear the claim and roll the schedule forward past `now`. */
export function releaseTask(
  task: DurableTask,
  now: number,
  status: RunStatus,
): DurableTask | undefined {
  const next = advanceSchedule(task, task.nextRunAt, now);
  const released: DurableTask = {
    ...task,
    lastRunAt: now,
    lastStatus: status,
  };
  delete released.runningSince;
  delete released.runnerPid;
  if (next === undefined) return undefined;
  return { ...released, nextRunAt: next };
}

export function appendRun(taskId: string, record: RunRecord): void {  const trimmed: RunRecord = {
    ...record,
    output: record.output ? truncate(record.output, MAX_RECORDED_OUTPUT) : undefined,
  };
  const path = runsPath(taskId);
  appendPrivate(path, `${JSON.stringify(trimmed)}\n`);

  // Compact only when the log has actually grown, so the common case stays a
  // single append rather than a read-rewrite of the whole history.
  try {
    if (statSync(path).size > MAX_RUN_LOG_BYTES) {
      const kept = readRuns(taskId, MAX_RUN_LOG_RECORDS);
      writePrivateAtomic(path, `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    }
  } catch {
    // Compaction is housekeeping; never fail a run over it.
  }
}

export function readRuns(taskId: string, limit = 20): RunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(runsPath(taskId), "utf8");
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // A partially written final line is expected after a crash; skip it.
    }
  }
  return records.slice(-limit);
}

export function forgetRuns(taskId: string): void {
  try {
    unlinkSync(runsPath(taskId));
  } catch {
    // Nothing recorded yet.
  }
}

/** Drop history for tasks that no longer exist, so the directory does not creep. */
export function pruneRuns(tasks: DurableTask[]): number {
  const live = new Set(tasks.map((task) => task.id));
  let entries: string[];
  try {
    entries = readdirSync(join(schedulerDir(), "runs"));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const id = entry.replace(/\.jsonl$/, "");
    if (id !== entry && !live.has(id)) {
      forgetRuns(id);
      removed += 1;
    }
  }
  return removed;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} more characters`;
}

export interface RunOutcomeLike {
  status: RunStatus;
  exitCode?: number;
  output?: string;
  error?: string;
}

/**
 * Record a finished run, clear its claim, and roll the schedule forward.
 *
 * One-shots have no next occurrence, so they leave the registry here. Their
 * outcome survives in the run log, which is the only place a reminder that
 * failed can still be found.
 */
export function settleRun(
  taskId: string,
  scheduledFor: number,
  startedAt: number,
  outcome: RunOutcomeLike,
): void {
  const endedAt = Date.now();
  appendRun(taskId, {
    runId: `${startedAt}`,
    startedAt,
    endedAt,
    scheduledFor,
    status: outcome.status,
    exitCode: outcome.exitCode,
    error: outcome.error,
    output: outcome.output || undefined,
  });

  withRegistry((registry) => {
    const index = registry.tasks.findIndex((candidate) => candidate.id === taskId);
    if (index < 0) return;
    const current = registry.tasks[index];
    if (!current) return;
    const released = releaseTask(current, endedAt, outcome.status);
    if (released) registry.tasks[index] = released;
    else registry.tasks.splice(index, 1);
    writeRegistry(registry);
  });
}

export function formatTask(task: DurableTask, now = Date.now()): string {
  const label = task.name ? `${task.id} (${task.name})` : task.id;
  const parts = [label, describeSchedule(task)];
  if (task.paused) parts.push("paused");
  else if (task.runningSince !== undefined) parts.push(`running for ${formatDuration(now - task.runningSince)}`);
  else parts.push(`next ${new Date(task.nextRunAt).toLocaleString()}`);
  if (task.model) parts.push(task.model);
  if (task.lastStatus) parts.push(`last ${task.lastStatus}`);
  parts.push(task.prompt.replace(/\s+/g, " ").slice(0, 60));
  return parts.join(" · ");
}
