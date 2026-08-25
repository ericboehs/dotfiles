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
/**
 * How long to trust "nobody is listening" before probing again.
 *
 * The probe below is a broadcast on the shared event bus, and the bus offers no
 * way to ask whether a channel has subscribers. So when pi-background-tasks is
 * not installed — the normal case — every single turn used to wait out the full
 * BG_RESPONSE_TIMEOUT_MS for a reply that could never come, which is a quarter
 * of a second of dead air between the agent settling and the tmux indicator.
 *
 * Latch the silence instead and skip the wait, but stay ready to be proven
 * wrong: any well-formed response seen on the bus lifts the latch immediately
 * (see watchForResponder), and this timer is the backstop for the case where
 * nothing is ever emitted to notice.
 */
const BG_PROBE_RETRY_MS = 5 * 60_000;

let requestSequence = 0;
/** Set once any well-formed response is seen; the probe is only skipped while false. */
let responderSeen = false;
/** Epoch ms of the last probe that timed out with no responder. */
let lastSilentProbeAt = 0;

interface BackgroundTask {
  status?: unknown;
  notifyOnCompletion?: unknown;
  triggerOnCompletion?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Watch the response channel for the lifetime of the extension.
 *
 * Without this the silence latch could only be undone by BG_PROBE_RETRY_MS,
 * and a responder that arrives mid-session (or simply answered one probe a
 * few milliseconds late, after its per-request listener was already torn down)
 * would go unnoticed for minutes. Any traffic at all is proof enough.
 */
function watchForResponder(pi: ExtensionAPI): void {
  pi.events.on(BG_RESPONSE, (value: unknown) => {
    if (isRecord(value) && value.schema_version === BG_RESPONSE_SCHEMA) responderSeen = true;
  });
}

async function hasRunningBackgroundTasks(pi: ExtensionAPI): Promise<boolean> {
  if (!responderSeen && Date.now() - lastSilentProbeAt < BG_PROBE_RETRY_MS) return false;
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

      // A reply of any shape proves somebody is on the channel, so stop
      // short-circuiting future probes even if this one reports nothing running.
      responderSeen = true;
      finish(
        value.result.tasks.some(
          (task: BackgroundTask) => isRecord(task) && task.status === "running",
        ),
      );
    });

    timer = setTimeout(() => {
      if (!responderSeen) lastSilentProbeAt = Date.now();
      finish(false);
    }, BG_RESPONSE_TIMEOUT_MS);
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

  watchForResponder(pi);

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

  /**
   * Maintain this pane's @agent_running flag and roll it up into the window's
   * @agent_count. The status bar dims #I on background windows while
   * @agent_count is set; Claude's hooks (claude-agent-state.sh) keep the same
   * convention, and ~/.tmux/agent-sync.sh clears flags orphaned by a dead
   * agent. Dimming is decided at render time from window_active, so the flag
   * is maintained even when this window is currently focused — switching away
   * mid-turn dims it without any extra bookkeeping.
   */
  const setRunning = async (on: boolean): Promise<void> => {
    try {
      await pi.exec(
        "tmux",
        on
          ? ["set-option", "-p", "-t", TMUX_PANE, "@agent_running", "on"]
          : ["set-option", "-p", "-u", "-t", TMUX_PANE, "@agent_running"],
        { timeout: 1000 },
      );

      // Recount every pane in this window: with several agents split across
      // panes, the dim must hold until the last one settles, not the first.
      const win = await pi.exec(
        "tmux",
        ["display-message", "-p", "-t", TMUX_PANE, "#{window_id}"],
        { timeout: 1000 },
      );
      if (win.code !== 0) return;
      const target = win.stdout.trim();
      const listing = await pi.exec(
        "tmux",
        ["list-panes", "-t", target, "-F", "#{@agent_running}"],
        { timeout: 1000 },
      );
      let count = 0;
      if (listing.code === 0) {
        for (const line of listing.stdout.split("\n")) {
          if (line.trim()) count++;
        }
      }
      if (count > 0) {
        await pi.exec(
          "tmux",
          ["set-window-option", "-t", target, "@agent_count", String(count)],
          { timeout: 1000 },
        );
      } else {
        await pi.exec(
          "tmux",
          ["set-window-option", "-u", "-t", target, "@agent_count"],
          { timeout: 1000 },
        );
      }
    } catch {
      // Same best-effort contract as markWindow above.
    }
  };

  // A working agent dims its background window's index until it settles.
  pi.on("agent_start", () => {
    void setRunning(true);
  });

  pi.on("agent_settled", async () => {
    // Clear this pane's running flag first: a turn that launched background
    // work still counts as settled for dimming purposes — the tasks below get
    // their own announcement path when they finish.
    await setRunning(false);

    // A turn that launched background work does not need attention yet. Its
    // completion notification will either wake another turn or be handled by
    // the terminal-event listener below.
    if (await hasRunningBackgroundTasks(pi)) return;
    await markWindow();
  });

  let removeTerminalListener: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    // Spend the one unavoidable probe here, while the session is idle at
    // startup, so the first turn's agent_settled already knows the answer
    // instead of paying the timeout at the worst possible moment.
    void hasRunningBackgroundTasks(pi);

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
    // Best effort: a clean exit should leave no dim behind. Anything harsher
    // is agent-sync's job.
    void setRunning(false);
  });
}
