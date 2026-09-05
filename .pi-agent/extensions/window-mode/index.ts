/**
 * Opt-in checkpoint compaction. Boot reads one small per-model preference only:
 * no history traversal, tool schemas, search index, timers, network, or AA.
 * The implementation is imported on the first enabled request/explicit command.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WindowRuntime } from "./runtime.ts";

export const COMPACTION_KIND = "window-mode/v1";

export function modelKey(ctx: Pick<ExtensionContext, "model">): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function preferencePath(key: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  // One file per exact provider/model avoids lost updates between sessions opting
  // different models in concurrently. No catalog, wildcards, or family matching.
  return join(agentDir, "window-mode", `${createHash("sha256").update(key).digest("hex")}.json`);
}

async function readPreference(key: string): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(preferencePath(key), "utf8"));
    return data?.version === 1 && data.model === key && data.enabled === true;
  } catch {
    // Absent/malformed configuration cannot opt a model in.
    return false;
  }
}

async function writePreference(key: string, enabled: boolean): Promise<void> {
  const path = preferencePath(key);
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, model: key, enabled }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Called lazily, never from session_start. Only the active ancestry is inspected. */
function hasWindowHistory(ctx: ExtensionContext): boolean {
  let entry = ctx.sessionManager.getLeafEntry();
  while (entry) {
    if (entry.type === "compaction" &&
        (entry.details as { kind?: string } | undefined)?.kind === COMPACTION_KIND) return true;
    entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined;
  }
  return false;
}

export default function windowMode(pi: ExtensionAPI): void {
  let selected: string | undefined;
  let enabled = false;
  let generation = 0;
  let recovery: boolean | undefined;
  let runtime: WindowRuntime | undefined;
  let loading: Promise<WindowRuntime> | undefined;
  const optedIn = (ctx: ExtensionContext) => enabled && modelKey(ctx) === selected;

  const implementation = async (): Promise<WindowRuntime> => {
    loading ??= import("./runtime.ts").then(({ createRuntime }) => {
      runtime = createRuntime(pi, optedIn);
      return runtime;
    });
    return loading;
  };

  const select = async (ctx: ExtensionContext) => {
    const ticket = ++generation;
    const key = modelKey(ctx);
    selected = key;
    enabled = false;
    const next = key ? await readPreference(key) : false;
    if (ticket !== generation) return;
    enabled = next;
    runtime?.activate(optedIn(ctx), recovery === true);
    runtime?.reset();
  };

  pi.on("session_start", async (_event, ctx) => {
    recovery = undefined;
    await select(ctx);
  });
  pi.on("model_select", async (_event, ctx) => select(ctx));
  pi.on("session_tree", () => {
    recovery = undefined;
    runtime?.reset();
  });
  pi.on("session_shutdown", () => {
    generation++;
    enabled = false;
    runtime?.reset();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Recovery remains available after switching to a non-opted-in model. Its
    // compaction still uses Pi's default, and fresh disabled sessions add nothing.
    recovery ??= hasWindowHistory(ctx);
    if (!optedIn(ctx) && !recovery && !runtime) return;
    const impl = await implementation();
    impl.activate(optedIn(ctx), recovery);
    return impl.beforeAgentStart(event, ctx);
  });
  pi.on("context", (event, ctx) => runtime?.context(event, ctx));
  pi.on("session_before_compact", async (event, ctx) => {
    if (!optedIn(ctx)) return;
    return (await implementation()).beforeCompact(event, ctx);
  });
  pi.on("session_compact", (event) => {
    const kind = (event.compactionEntry.details as { kind?: string } | undefined)?.kind;
    if (kind === COMPACTION_KIND) recovery = true;
    runtime?.completed(kind);
    runtime?.reset();
  });
  pi.on("session_compact_failed", () => runtime?.reset());

  pi.registerCommand("window-mode", {
    description: "Checkpoint compaction: on/off/status for this exact provider/model",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      const key = modelKey(ctx);
      const notify = (text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
      };
      if (!key) { notify("Select a model first.", "warning"); return; }
      if (action === "status") {
        notify(`Window mode ${optedIn(ctx) ? "on" : "off"}: ${key}. ${runtime?.stats() ?? "Not loaded; no initial context overhead."}`);
        return;
      }
      if (action !== "on" && action !== "off") {
        notify("Usage: /window-mode [on|off|status]", "warning");
        return;
      }
      // Never mutate tools/policy in the middle of a tool batch.
      await ctx.waitForIdle();
      if (modelKey(ctx) !== key) { notify("Model changed; run the command again.", "warning"); return; }
      await writePreference(key, action === "on");
      await select(ctx);
      recovery ??= hasWindowHistory(ctx);
      if (optedIn(ctx) || recovery || runtime) {
        (await implementation()).activate(optedIn(ctx), recovery);
      }
      notify(`Window mode ${action}: ${key}. Saved for future sessions; other running sessions need /reload.`);
    },
  });
}
