import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mirror Claude Code's Stop hook (~/.claude/hooks/log-session.sh): keep
// ~/Documents/Wiki/AI Sessions/ current so /checkin and /update-sessions see pi
// work alongside Claude work.
//
// This extension deliberately knows nothing about the wiki format. All it does
// is poke `pi-session-sync` (bin/pi-session-sync in this repo), which reads
// this session's JSONL and regenerates
// the markdown from scratch. /checkin runs the same command with --all as a
// backstop, so there is one implementation behind two triggers -- no second
// renderer here to drift out of sync with the first.

// Prefer an explicit path over a bare PATH lookup: pi may be launched from a
// GUI or a login shell whose PATH lacks ~/bin, and a silently-unfound converter
// would look exactly like "logging works" until checkin came up empty.
// ~/bin is this repo's own bin/ (symlinked by mise), so it is the real home.
const SYNC_BIN =
  [
    join(homedir(), "bin", "pi-session-sync"),
    join(homedir(), ".local", "bin", "pi-session-sync"),
  ].find((p) => existsSync(p)) ?? "pi-session-sync";

export default function (pi: ExtensionAPI) {
  let sessionFile: string | undefined;
  let running = false;
  let queued = false;

  const sync = () => {
    if (!sessionFile) return;
    // The converter rewrites the whole file, so overlapping runs would just
    // race to produce identical bytes. Collapse them into one trailing run.
    if (running) {
      queued = true;
      return;
    }
    running = true;

    const child = spawn(SYNC_BIN, [sessionFile], {
      detached: true,
      stdio: "ignore",
    });
    // Never let a missing or broken converter take pi down with it -- this is
    // note-keeping, not part of the agent loop.
    child.on("error", () => {
      running = false;
      queued = false;
    });
    child.on("exit", () => {
      running = false;
      if (queued) {
        queued = false;
        sync();
      }
    });
    child.unref();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile?.();
  });

  // agent_settled is pi's analogue of Claude Code's Stop hook: the turn is done
  // and the transcript on disk is complete through this exchange.
  pi.on("agent_settled", (_event, ctx) => {
    sessionFile ??= ctx.sessionManager.getSessionFile?.();
    sync();
  });

  // Catches the tail of a session that ends without settling (quit mid-turn),
  // and re-points at the new file when pi swaps sessions underneath us.
  pi.on("session_shutdown", () => {
    sync();
  });
}
