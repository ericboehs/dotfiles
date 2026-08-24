/**
 * Headless execution of one durable task.
 *
 * A scheduled run is a fresh, isolated `pi -p` process, never a message into an
 * existing session: pi appends to session JSONL without locking, so writing
 * into a session that might be open in a terminal risks interleaved entries.
 * Isolation also means the run cannot inherit whatever model or context a
 * human happened to leave in a session three days ago.
 *
 * Discovery is on by default — the same extensions, skills, prompt templates
 * and AGENTS.md an interactive pi would load — because a scheduled prompt
 * should behave like the pi you would have typed it into. That is also what
 * makes `/checkin` work as a scheduled prompt. `without` strips pieces back
 * out. Themes are always off: there is no TUI to theme.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import {
  DEFAULT_TIMEOUT_MS,
  type DurableTask,
  enabledFeatures,
  type RunStatus,
  truncate,
} from "./task-registry.ts";

export interface RunOutcome {
  status: RunStatus;
  exitCode?: number;
  output: string;
  error?: string;
}

const MAX_CAPTURED_OUTPUT = 200_000;

export function piArgsFor(task: DurableTask): string[] {
  const enabled = enabledFeatures(task);
  // Always off: a headless run has no TUI, and saving a session for something
  // that runs unattended every day would grow a session file forever.
  const args = ["-p", "--no-session", "--no-themes"];
  if (!enabled.has("extensions")) args.push("--no-extensions");
  if (!enabled.has("skills")) args.push("--no-skills");
  if (!enabled.has("templates")) args.push("--no-prompt-templates");
  if (!enabled.has("context")) args.push("--no-context-files");
  if (!enabled.has("tools")) args.push("--no-tools");
  if (task.model) args.push("--model", task.model);
  return args;
}

interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function capture(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A wedged model call ignores SIGTERM; do not let a stuck run hold its
      // claim until CLAIM_STALE_MS expires.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * Run the task's prompt and, if it has one, its delivery command.
 *
 * The prompt goes in on stdin rather than argv so it never appears in `ps`
 * output, and the same is true of the result handed to `deliver`.
 */
export async function runTask(
  task: DurableTask,
  options: { piBin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunOutcome> {
  const piBin = options.piBin ?? process.env.PI_SCHEDULER_PI_BIN ?? "pi";
  const env = options.env ?? process.env;
  // A task records the directory it was created in, so project extensions and
  // AGENTS.md resolve the way they did when the prompt was written. $HOME is
  // only the fallback for a task whose directory has since gone away.
  const cwd = existsSync(task.cwd ?? "") ? (task.cwd as string) : homedir();
  const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: CaptureResult;
  try {
    result = await capture(piBin, piArgsFor(task), {
      cwd,
      env,
      input: task.prompt,
      timeoutMs,
    });
  } catch (error) {
    return {
      status: "error",
      output: "",
      error: `could not start ${piBin}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const output = result.stdout.trim();
  if (result.timedOut) {
    return { status: "timeout", output, error: `no result within ${timeoutMs}ms` };
  }
  if (result.code !== 0) {
    return {
      status: "error",
      exitCode: result.code ?? undefined,
      output,
      error: truncate(result.stderr.trim() || `pi exited ${result.code ?? result.signal}`, 2_000),
    };
  }

  if (!task.deliver) return { status: "ok", exitCode: 0, output };

  // Empty output is a successful no-op, not something to page about.
  if (!output) return { status: "ok", exitCode: 0, output };

  let delivery: CaptureResult;
  try {
    delivery = await capture("/bin/sh", ["-c", task.deliver], {
      cwd,
      env: { ...env, PI_SCHEDULER_OUTPUT: output, PI_SCHEDULER_TASK: task.name ?? task.id },
      input: output,
      timeoutMs: 120_000,
    });
  } catch (error) {
    return {
      status: "error",
      output,
      error: `deliver failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (delivery.timedOut || delivery.code !== 0) {
    return {
      status: "error",
      exitCode: delivery.code ?? undefined,
      output,
      error: truncate(
        delivery.stderr.trim() || `deliver exited ${delivery.code ?? delivery.signal}`,
        2_000,
      ),
    };
  }

  return { status: "ok", exitCode: 0, output };
}
