// Show the existing ⊙ tmux window indicator when pi needs attention in a
// background window. Focusing any pane in that window clears the indicator via
// the pane-focus-in hook in ~/.tmux.conf.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TMUX_PANE = process.env.TMUX_PANE;
const BG_REQUEST = "pi-background-tasks:request:v1";
const BG_RESPONSE = "pi-background-tasks:response:v1";
const BG_TERMINAL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";
const BG_RESPONSE_TIMEOUT_MS = 250;

let requestSequence = 0;

interface BackgroundTask {
  status?: unknown;
  notifyOnCompletion?: unknown;
  triggerOnCompletion?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hasRunningBackgroundTasks(pi: ExtensionAPI): Promise<boolean> {
  const requestId = `tmux-attention-${process.pid}-${Date.now()}-${++requestSequence}`;

  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (running: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      off();
      resolve(running);
    };

    const off = pi.events.on(BG_RESPONSE, (value: unknown) => {
      if (!isRecord(value) || value.schema_version !== BG_RESPONSE_SCHEMA) return;
      if (value.request_id !== requestId || value.ok !== true) return;
      if (!isRecord(value.result) || !Array.isArray(value.result.tasks)) return;

      finish(
        value.result.tasks.some(
          (task: BackgroundTask) => isRecord(task) && task.status === "running",
        ),
      );
    });

    timer = setTimeout(() => finish(false), BG_RESPONSE_TIMEOUT_MS);
    try {
      pi.events.emit(BG_REQUEST, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: requestId,
        operation: "status",
        payload: {},
      });
    } catch {
      finish(false);
    }
  });
}

export default function (pi: ExtensionAPI): void {
  if (!TMUX_PANE) return;

  const markWindow = async () => {
    try {
      // Match the Claude hook: a turn only needs announcing when its window is
      // not the active window. Split panes in the active window remain visible.
      const visible = await pi.exec(
        "tmux",
        ["display-message", "-p", "-t", TMUX_PANE, "#{window_active}"],
        { timeout: 1000 },
      );
      if (visible.code !== 0 || visible.stdout.trim() === "1") return;

      await pi.exec(
        "tmux",
        ["set-window-option", "-t", TMUX_PANE, "@special_activity", "on"],
        { timeout: 1000 },
      );
    } catch {
      // tmux may have exited or the pane may have moved between checks. This is
      // a best-effort status hint, so never surface failures inside pi.
    }
  };

  pi.on("agent_settled", async () => {
    // A turn that launched background work does not need attention yet. Its
    // completion notification will either wake another turn or be handled by
    // the terminal-event listener below.
    if (await hasRunningBackgroundTasks(pi)) return;
    await markWindow();
  });

  let removeTerminalListener: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    removeTerminalListener?.();
    removeTerminalListener = pi.events.on(BG_TERMINAL, (value: unknown) => {
      if (!isRecord(value) || value.schema_version !== BG_TERMINAL_SCHEMA) return;
      if (!isRecord(value.task)) return;
      const task = value.task as BackgroundTask;

      // A triggering completion starts another agent turn; wait for that turn's
      // agent_settled event. Notification-only completions need announcing here,
      // unless an unrelated foreground turn is still working.
      if (
        task.notifyOnCompletion !== true ||
        task.triggerOnCompletion === true ||
        !ctx.isIdle()
      ) {
        return;
      }
      void hasRunningBackgroundTasks(pi).then((running) => {
        if (!running) void markWindow();
      });
    });
  });

  pi.on("session_shutdown", () => {
    removeTerminalListener?.();
    removeTerminalListener = undefined;
  });
}
