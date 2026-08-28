/**
 * Message stash — Claude Code-style ctrl+s.
 *
 * Parks the editor draft on a LIFO stack, restores on empty ctrl+s or after
 * the next send. The stack lives on globalThis so /reload (which re-instantiates
 * the module) does not wipe it. Drafts stay in-process; they are not written
 * to disk and they do not enter model context.
 *
 * @replaces npm:@nicknisi/pi-stash
 * Do not load both — they both bind ctrl+s.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "message-stash";
const STORE_KEY = "__piMessageStash";

type StashStore = Map<string, string[]>;

function store(): StashStore {
  const root = globalThis as typeof globalThis & { [STORE_KEY]?: StashStore };
  root[STORE_KEY] ??= new Map();
  return root[STORE_KEY];
}

function stackFor(ctx: ExtensionContext): string[] {
  const id = ctx.sessionManager.getSessionId();
  const stacks = store();
  let stack = stacks.get(id);
  if (!stack) {
    stack = [];
    stacks.set(id, stack);
  }
  return stack;
}

export default function stash(pi: ExtensionAPI) {
  const updateWidget = (ctx: ExtensionContext, stack: string[]) => {
    if (!ctx.hasUI) return;
    if (stack.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const latest = stack[stack.length - 1]!;
    const firstLine = latest.split("\n")[0] ?? "";
    const preview = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    const count = stack.length > 1 ? theme.fg("dim", ` (+${stack.length - 1} more)`) : "";
    ctx.ui.setWidget(WIDGET_KEY, [
      `${theme.fg("accent", "⧉ stashed:")} ${theme.fg("muted", preview)}${count} ${theme.fg("dim", "· ctrl+s to restore")}`,
    ]);
  };

  pi.on("session_start", async (_event, ctx) => {
    updateWidget(ctx, stackFor(ctx));
  });

  pi.registerShortcut("ctrl+s", {
    description: "Stash / restore the typed message",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const stack = stackFor(ctx);
      const text = ctx.ui.getEditorText();
      if (text.trim().length > 0) {
        stack.push(text);
        ctx.ui.setEditorText("");
      } else if (stack.length > 0) {
        ctx.ui.setEditorText(stack.pop()!);
      }
      updateWidget(ctx, stack);
    },
  });

  // After a message is submitted, auto-restore the most recent stash into
  // the now-empty editor (mirrors Claude Code's behavior).
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const stack = stackFor(ctx);
    if (stack.length === 0) return;
    if (ctx.ui.getEditorText().trim().length > 0) return;
    ctx.ui.setEditorText(stack.pop()!);
    updateWidget(ctx, stack);
  });
}
