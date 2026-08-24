import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  describeSchedule,
  firstRunAfter,
  formatDuration,
  parseDuration,
  parseScheduleSpec,
} from "./lib/schedule-core.ts";
import {
  DEFAULT_MISFIRE_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  type DurableTask,
  enabledFeatures,
  FEATURES,
  MAX_DURABLE_TASKS,
  type MisfirePolicy,
  findTask,
  formatTask,
  makeTaskId,
  parseFeatures,
  readRegistry,
  readRuns,
  registryPath,
  settleRun,
  writeRegistry,
  withRegistry,
} from "./lib/task-registry.ts";
import { runTask } from "./lib/runner.ts";

type NoticeLevel = "info" | "warning" | "error";

/**
 * Split on whitespace but keep quoted runs together, so `--deliver 'slack-noti'`
 * survives being flattened into a single slash-command argument string.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

export interface ParsedFlags {
  flags: Record<string, string | boolean>;
  rest: string;
}

const VALUE_FLAGS = new Set(["name", "model", "cwd", "with", "without", "deliver", "misfire", "timeout"]);
const BOOLEAN_FLAGS = new Set(["tools", "no-tools", "no-deliver"]);

/**
 * Flags are only recognized at the front, before the schedule.
 *
 * The alternative — scanning the whole line — cannot tell a `--model` option
 * from the same text inside a prompt, and the schedule spec is variable length
 * (a cron expression is five bare words), so there is no reliable point to
 * stop. Leading-only is unambiguous and easy to remember.
 */
export function parseLeadingFlags(input: string): ParsedFlags | { error: string } {
  const flags: Record<string, string | boolean> = {};
  let remainder = input.trim();

  while (remainder.startsWith("--")) {
    const [token] = tokenize(remainder);
    if (!token) break;
    const name = token.slice(2).split("=")[0] ?? "";

    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      remainder = remainder.slice(token.length).trim();
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return { error: `Unknown option --${name}` };

    const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
    if (inline !== undefined) {
      flags[name] = inline;
      remainder = remainder.slice(token.length).trim();
      continue;
    }
    const after = remainder.slice(token.length).trim();
    const [value] = tokenize(after);
    if (value === undefined) return { error: `--${name} needs a value` };
    flags[name] = value;
    // Skip the raw span of the value, quotes included, rather than the token.
    const quoted = after.match(/^("[^"]*"|'[^']*'|\S+)/);
    remainder = after.slice(quoted?.[0].length ?? value.length).trim();
  }

  return { flags, rest: remainder };
}

function applyFlags(
  task: DurableTask,
  flags: Record<string, string | boolean>,
): DurableTask {
  const updated = { ...task };
  if (typeof flags.name === "string") updated.name = flags.name;
  if (typeof flags.model === "string") updated.model = flags.model;
  if (typeof flags.cwd === "string") updated.cwd = flags.cwd;
  if (flags.tools === true) updated.without = (updated.without ?? []).filter((f) => f !== "tools");
  if (flags["no-tools"] === true) {
    updated.without = [...new Set([...(updated.without ?? []), "tools" as const])];
  }
  if (typeof flags.with === "string") {
    const parsed = parseFeatures(flags.with);
    if ("error" in parsed) throw new Error(`--with ${parsed.error}`);
    // An allowlist: everything not named is switched off.
    updated.without = FEATURES.filter((feature) => !parsed.features.includes(feature));
  }
  if (typeof flags.without === "string") {
    const parsed = parseFeatures(flags.without);
    if ("error" in parsed) throw new Error(`--without ${parsed.error}`);
    updated.without = parsed.features;
  }
  delete updated.enable;
  delete updated.tools;
  if (flags["no-deliver"] === true) delete updated.deliver;
  if (typeof flags.deliver === "string") updated.deliver = flags.deliver;

  if (typeof flags.misfire === "string") {
    const policy: MisfirePolicy | undefined = flags.misfire === "skip" || flags.misfire === "always"
      ? flags.misfire
      : parseDuration(flags.misfire);
    if (policy === undefined) throw new Error("--misfire wants skip, always, or a duration such as 2h");
    updated.misfire = policy;
  }
  if (typeof flags.timeout === "string") {
    const ms = parseDuration(flags.timeout);
    if (ms === undefined) throw new Error("--timeout wants a duration such as 15m");
    updated.timeoutMs = ms;
  }
  return updated;
}

function describeMisfire(task: DurableTask): string {
  const policy = task.misfire ?? DEFAULT_MISFIRE_GRACE_MS;
  if (policy === "skip") return "skip if late";
  if (policy === "always") return "always run, however late";
  return `catch up within ${formatDuration(policy)}`;
}

/** What discovery this run gets, phrased for someone reading `show`. */
export function describeFeatures(task: DurableTask): string {
  const enabled = enabledFeatures(task);
  const off = FEATURES.filter((feature) => !enabled.has(feature));
  if (off.length === 0) return "everything, same as an interactive pi";
  if (enabled.size === 0) return "nothing (bare pi, no tools)";
  return `everything except ${off.join(", ")}`;
}

/**
 * `/schedule` — durable tasks that run without an open session.
 *
 * Unlike `/once` and `/loop`, nothing here arms a timer in this process. The
 * command only edits ~/.pi/agent/scheduler/tasks.json; a launchd job (a systemd
 * timer on Linux) runs `pi-scheduler check` every minute and starts a fresh,
 * isolated `pi -p` for whatever is due. That is why each task carries its own
 * model, cwd and tool policy: there is no session to inherit them from.
 *
 * The extension costs one command registration and no tools, and it touches
 * the filesystem only when the command is actually run, so it adds nothing to
 * model context or to pi's startup.
 */
export default function durableScheduler(pi: ExtensionAPI): void {
  const notice = (ctx: ExtensionContext, message: string, level: NoticeLevel = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stdout.write(`${message}\n`);
  };

  const showUsage = (ctx: ExtensionContext) => {
    notice(
      ctx,
      [
        "Durable tasks (run without an open session, via the pi-scheduler LaunchAgent):",
        "  /schedule [options] daily <HH:MM|9a> :: <prompt>",
        "  /schedule [options] every <duration> :: <prompt>",
        "  /schedule [options] hourly :: <prompt>",
        "  /schedule [options] cron <m h dom mon dow|@daily> :: <prompt>",
        "  /schedule [options] once <duration|HH:MM|ISO> :: <prompt>",
        "  /schedule list [all] | show <id> | runs <id>",
        "  /schedule run <id> | pause <id> | resume <id> | remove <id>",
        "",
        "Options go first: --name --model --cwd --with/--without --deliver",
        "                  --misfire --timeout",
        "  /schedule --name grades --model cerebras/gpt-oss-120b:low daily 15:30 :: check grades",
        "",
        "/schedule help explains what each option does.",
        "For timers that fire into this conversation, use /once and /loop.",
      ].join("\n"),
      "warning",
    );
  };

  const showHelp = (ctx: ExtensionContext) => {
    notice(
      ctx,
      [
        "/schedule \u2014 tasks that run without an open session.",
        "",
        "A launchd job (a systemd timer on Linux) runs 'pi-scheduler check' every",
        "minute. When a task is due it starts a fresh pi, which then exits. Nothing",
        "stays resident, and no model runs on the ticks where nothing is due.",
        "",
        "A run loads what an interactive pi would: your extensions, skills, prompt",
        "templates, the AGENTS.md of the directory the task was created in, and",
        "tools. So the prompt can be a slash command, and behaves as if you typed",
        "it. It does not join an existing session; each run is its own pi.",
        "",
        "SCHEDULES                        :: separates the schedule from the prompt",
        "  daily 15:30   daily 9a         every day at that local time",
        "  every 30m     hourly           repeating; 1m minimum",
        "  cron 30 15 * * 1-5             5-field crontab, or @daily @hourly @weekly",
        "  once 2h       once 20:00       fires one time, then retires",
        "",
        "OPTIONS  (all optional, and all must come before the schedule)",
        "  --name <name>       what you call it in show/run/remove; else a short id",
        "  --model <model>     which model runs it, e.g. cerebras/gpt-oss-120b:low.",
        "                      Worth setting: runs are isolated, so there is no",
        "                      session to inherit a model from, and a summarising",
        "                      job rarely needs an expensive one.",
        "  --cwd <dir>         directory to run in. Defaults to where you created",
        "                      the task, so project extensions and AGENTS.md are the",
        "                      ones you had in mind.",
        "  --without <list>    drop discovery you do not want, comma separated:",
        "                        extensions  your pi extensions",
        "                        skills      SKILL.md files",
        "                        templates   prompt templates (/checkin and friends)",
        "                        context     AGENTS.md and CLAUDE.md",
        "                        tools       the model's ability to act",
        "                      --without tools makes a run answer-only, which is",
        "                      worth doing for anything that just summarises.",
        "  --with <list>       the inverse: load only what you name, nothing else.",
        "                      --with none is a bare pi, about 0.3s faster and",
        "                      immune to a broken extension.",
        "  --deliver <cmd>     shell command receiving the output on stdin and in",
        "                      $PI_SCHEDULER_OUTPUT. Without it the only trace of a",
        "                      run is '/schedule runs <id>', since nobody is watching.",
        "  --misfire <policy>  what a late run does after sleep or shutdown:",
        "                        skip     never run late",
        "                        always   run however late",
        "                        <dur>    catch up within this window (default 2h)",
        "                      Late runs coalesce into one; a week away does not",
        "                      replay a week of runs.",
        "  --timeout <dur>     give up on a run after this long (default 15m)",
        "",
        "MANAGING",
        "  list [all]          soonest first; 'all' includes paused tasks",
        "  show <id>           schedule, model, delivery, last and next run",
        "  runs <id>           recent history, including failures and skips",
        "  run <id>            run now, ignoring the schedule",
        "  pause <id> | resume <id>",
        "                      resume rolls forward to the next future slot rather",
        "                      than replaying what was missed",
        "  remove <id>         delete the task and its history",
        "",
        "EXAMPLE",
        "  /schedule --name grades --model cerebras/gpt-oss-120b:low",
        "    --deliver 'fnox exec -- slack-noti'",
        "    cron 30 15 * * 1-5 :: Summarize today's grades, flag anything under 80.",
        "",
        "Same tasks from the shell: pi-scheduler (add, list, run, runs, install).",
        "Timers that fire into this conversation instead: /once and /loop.",
      ].join("\n"),
      "info",
    );
  };

  pi.registerCommand("schedule", {
    description: "Manage durable tasks that run headlessly, even with pi closed",
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

      try {
        if (/^(list|ls)(\s+all)?$/i.test(input)) {
          const all = /all\s*$/i.test(input);
          const tasks = readRegistry().tasks
            .filter((task) => all || !task.paused)
            .sort((a, b) => a.nextRunAt - b.nextRunAt);
          notice(
            ctx,
            tasks.length > 0
              ? tasks.map((task) => formatTask(task)).join("\n")
              : `No durable tasks (${registryPath()})`,
          );
          return;
        }

        const show = input.match(/^show\s+(\S+)$/i);
        if (show?.[1]) {
          const task = findTask(readRegistry().tasks, show[1]);
          notice(ctx, [
            `${task.id}${task.name ? ` (${task.name})` : ""}`,
            `schedule  ${describeSchedule(task)}`,
            `next run  ${task.paused ? "paused" : new Date(task.nextRunAt).toLocaleString()}`,
            `model     ${task.model ?? "pi default"}`,
            `runs with ${describeFeatures(task)}`,
            `cwd       ${task.cwd ?? "$HOME"}`,            `deliver   ${task.deliver ?? "—"}`,
            `misfire   ${describeMisfire(task)}`,
            `timeout   ${formatDuration(task.timeoutMs ?? DEFAULT_TIMEOUT_MS)}`,
            `last run  ${task.lastRunAt ? `${new Date(task.lastRunAt).toLocaleString()} (${task.lastStatus})` : "never"}`,
            `prompt    ${task.prompt}`,
          ].join("\n"));
          return;
        }

        const runs = input.match(/^runs?\s+(\S+)$/i);
        if (runs?.[1]) {
          const task = findTask(readRegistry().tasks, runs[1]);
          const records = readRuns(task.id, 10);
          notice(
            ctx,
            records.length > 0
              ? records.map((record) =>
                  `${new Date(record.startedAt).toLocaleString()} · ${record.status}`
                  + ` · ${formatDuration(record.endedAt - record.startedAt)}`
                  + `${record.error ? ` · ${record.error.split("\n")[0]}` : ""}`,
                ).join("\n")
              : "No runs recorded yet",
          );
          return;
        }

        const run = input.match(/^run\s+(\S+)$/i);
        if (run?.[1]) {
          const selector = run[1];
          // Claim first, so a scheduled tick a second later does not run the
          // same task concurrently with this manual one.
          const claimed = withRegistry((registry) => {
            const existing = findTask(registry.tasks, selector);
            if (existing.runningSince !== undefined) {
              throw new Error(`${existing.name ?? existing.id} is already running`);
            }
            const index = registry.tasks.indexOf(existing);
            const task = { ...existing, runningSince: Date.now(), runnerPid: process.pid };
            registry.tasks[index] = task;
            writeRegistry(registry);
            return task;
          });

          notice(ctx, `Running ${claimed.name ?? claimed.id} headlessly…`);
          const startedAt = Date.now();
          let outcome;
          try {
            outcome = await runTask(claimed);
          } catch (error) {
            outcome = {
              status: "error" as const,
              output: "",
              error: error instanceof Error ? error.message : String(error),
            };
          }
          settleRun(claimed.id, claimed.nextRunAt, startedAt, outcome);
          notice(
            ctx,
            `${claimed.name ?? claimed.id} ${outcome.status}`
            + `${outcome.error ? `: ${outcome.error}` : ""}`
            + `${outcome.output ? `\n${outcome.output}` : ""}`,
            outcome.status === "ok" ? "info" : "error",
          );
          return;
        }

        const toggle = input.match(/^(pause|resume)\s+(\S+)$/i);
        if (toggle?.[1] && toggle[2]) {
          const paused = toggle[1].toLowerCase() === "pause";
          const selector = toggle[2];
          withRegistry((registry) => {
            const existing = findTask(registry.tasks, selector);
            const index = registry.tasks.indexOf(existing);
            const task = { ...existing, paused };
            // Resuming must not replay slots missed while paused.
            if (!paused && task.nextRunAt <= Date.now()) {
              task.nextRunAt = firstRunAfter(task) ?? task.nextRunAt;
            }
            registry.tasks[index] = task;
            writeRegistry(registry);
            notice(ctx, formatTask(task));
          });
          return;
        }

        const remove = input.match(/^(?:remove|rm|delete|cancel)\s+(\S+)$/i);
        if (remove?.[1]) {
          const selector = remove[1];
          withRegistry((registry) => {
            const task = findTask(registry.tasks, selector);
            registry.tasks = registry.tasks.filter((candidate) => candidate.id !== task.id);
            writeRegistry(registry);
            notice(ctx, `Removed ${task.name ?? task.id}; its run history is kept until pi-scheduler prune`);
          });
          return;
        }

        const parsedFlags = parseLeadingFlags(input);
        if ("error" in parsedFlags) {
          notice(ctx, parsedFlags.error, "error");
          return;
        }

        const parsed = parseScheduleSpec(parsedFlags.rest);
        if ("error" in parsed) {
          notice(ctx, parsed.error, "error");
          showUsage(ctx);
          return;
        }

        withRegistry((registry) => {
          if (registry.tasks.length >= MAX_DURABLE_TASKS) {
            notice(ctx, `Already at ${MAX_DURABLE_TASKS} durable tasks`, "error");
            return;
          }
          const name = parsedFlags.flags.name;
          if (typeof name === "string" && registry.tasks.some((task) => task.name === name)) {
            notice(ctx, `A task named ${name} already exists`, "error");
            return;
          }

          const applied = applyFlags({
            ...parsed.schedule,
            id: makeTaskId(registry.tasks),
            prompt: parsed.prompt,
            // Recorded now, not resolved at run time: the run should see the
            // project you were sitting in when you wrote the prompt.
            cwd: ctx.cwd,
            createdAt: Date.now(),
            nextRunAt: parsed.nextRunAt,
          }, parsedFlags.flags);

          registry.tasks.push(applied);
          writeRegistry(registry);
          notice(ctx, [
            formatTask(applied),
            describeMisfire(applied),
            `runs in ${applied.cwd} with ${describeFeatures(applied)}`,
          ].join("\n"));
        });
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
