/**
 * Message stash — Claude Code-style ctrl+s, plus /stash manager.
 *
 * Parks the editor draft on a LIFO stack, restores on empty ctrl+s or after
 * the next send. The stack lives on globalThis so /reload (which re-instantiates
 * the module) does not wipe it. Drafts stay in-process; they are not written
 * to disk and they do not enter model context.
 *
 * /stash opens the stack in a panel (same pattern as /bg): top entry restores
 * first. j/k (or arrows) select, J/K move the entry (reorder = rearrange
 * restore priority), enter restores one into the editor, e edits the selected
 * stash raw in $EDITOR and returns to the list (escaping the edit does too),
 * d drops it, esc closes. Reorders and deletes apply immediately; only
 * restore, empty, or esc leaves the manager. Clicking the stashed bar above
 * the editor opens the manager too (same click-only pattern as the
 * next-steps chips, so transcript drag-select keeps working).
 *
 * Mid-turn safe: the command is local UI + in-memory state only. Extension
 * commands bypass the input queue, so /stash opens immediately even while the
 * agent is working. Restore parks text in the editor as a draft and never
 * steers or interrupts the run.
 *
 * @replaces npm:@nicknisi/pi-stash
 * Do not load both — they both bind ctrl+s.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "message-stash";
const STORE_KEY = "__piMessageStash";
/** Full-text preview lines for the selected stash in the panel. */
const PREVIEW_LINES = 8;

interface StashEntry {
  id: string;
  text: string;
  ts: number;
}

type StashStore = Map<string, StashEntry[]>;

function store(): StashStore {
  const root = globalThis as typeof globalThis & { [STORE_KEY]?: StashStore };
  root[STORE_KEY] ??= new Map();
  return root[STORE_KEY];
}

function stackFor(ctx: ExtensionContext): StashEntry[] {
  const id = ctx.sessionManager.getSessionId();
  const stacks = store();
  let stack = stacks.get(id);
  if (!stack) {
    stack = [];
    stacks.set(id, stack);
  }
  return stack;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function age(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type StashAction = { action: "restore" | "edit"; id: string };

interface PanelDeps {
  tui: { requestRender(): void };
  theme: { fg(color: string, text: string): string };
  getStack: () => StashEntry[];
  done: (result: StashAction | undefined) => void;
}

/**
 * Stash panel: list view with full-text preview of the selection.
 * Selection is tracked by entry id so deletes/moves never strand it on the
 * wrong row. Rows show newest (restores-first) at the top.
 */
class StashPanel {
  private selectedId: string | undefined;
  // Declared field rather than a constructor parameter property: the shared
  // tsconfig sets erasableSyntaxOnly, so extensions stay importable by plain
  // Node in strip-only mode.
  private readonly deps: PanelDeps;

  constructor(deps: PanelDeps) {
    this.deps = deps;
  }

  /** Newest first: rows[0] is what the next ctrl+s would restore. */
  private ordered(): StashEntry[] {
    return [...this.deps.getStack()].reverse();
  }

  private current(): StashEntry | undefined {
    const rows = this.ordered();
    return rows.find((entry) => entry.id === this.selectedId) ?? rows[0];
  }

  private moveSelection(delta: number): void {
    const rows = this.ordered();
    if (rows.length === 0) return;
    const index = Math.max(
      0,
      rows.findIndex((entry) => entry.id === this.selectedId),
    );
    const next = Math.max(0, Math.min(rows.length - 1, index + delta));
    this.selectedId = rows[next]?.id;
  }

  /**
   * Move the selected entry. direction -1 = up (restores sooner), +1 = down
   * (restores later). Rows are reversed vs the stack, so row-up is stack +1.
   */
  private moveEntry(direction: -1 | 1): void {
    const stack = this.deps.getStack();
    const selected = this.current();
    if (!selected) return;
    const i = stack.findIndex((entry) => entry.id === selected.id);
    const j = i - direction;
    if (i < 0 || j < 0 || j >= stack.length) return;
    const tmp = stack[i]!;
    stack[i] = stack[j]!;
    stack[j] = tmp;
  }

  private deleteSelected(): void {
    const stack = this.deps.getStack();
    const selected = this.current();
    if (!selected) return;
    const i = stack.findIndex((entry) => entry.id === selected.id);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) this.deps.done(undefined);
  }

  handleInput(data: string): void {
    if (this.selectedId === undefined) this.selectedId = this.ordered()[0]?.id;

    if (matchesKey(data, "up") || data === "k") {
      this.moveSelection(-1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.moveSelection(1);
    } else if (data === "K") {
      this.moveEntry(-1);
    } else if (data === "J") {
      this.moveEntry(1);
    } else if (matchesKey(data, "enter")) {
      const selected = this.current();
      if (selected) this.deps.done({ action: "restore", id: selected.id });
      return;
    } else if (data === "e") {
      const selected = this.current();
      if (selected) this.deps.done({ action: "edit", id: selected.id });
      return;
    } else if (data === "d" || data === "x") {
      this.deleteSelected();
    } else if (matchesKey(data, "escape") || data === "q") {
      this.deps.done(undefined);
      return;
    }
    this.deps.tui.requestRender();
  }

  invalidate(): void {
    // Nothing cached between renders.
  }

  render(width: number): string[] {
    const { theme } = this.deps;
    const rows = this.ordered();
    if (this.selectedId === undefined) this.selectedId = rows[0]?.id;
    const out = [
      truncateToWidth(theme.fg("accent", `Stash (${rows.length}) · top restores first`), width),
      "",
    ];

    rows.forEach((entry, n) => {
      const firstLine = (entry.text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
      const lineCount = entry.text.split("\n").length;
      const meta = ` · ${age(entry.ts)} · ${lineCount} line${lineCount === 1 ? "" : "s"}`;
      const room = Math.max(10, width - visibleWidth(`${n + 1}${meta}`) - 4);
      const preview = truncateToWidth(firstLine, room);
      const row = `${n + 1} ${preview}${theme.fg("dim", meta)}`;
      out.push(
        entry.id === this.selectedId
          ? truncateToWidth(theme.fg("accent", `❯ ${row}`), width)
          : truncateToWidth(`  ${row}`, width),
      );
    });

    const selected = this.current();
    if (selected) {
      out.push("");
      out.push(truncateToWidth(theme.fg("dim", "Preview:"), width));
      const lines = selected.text.split("\n").slice(0, PREVIEW_LINES);
      for (const line of lines) out.push(truncateToWidth(`  ${line}`, width));
      const rest = selected.text.split("\n").length - lines.length;
      if (rest > 0) out.push(truncateToWidth(theme.fg("dim", `  … (+${rest} lines)`), width));
    }

    out.push("");
    out.push(
      truncateToWidth(
        theme.fg("dim", "j/k select · J/K move · enter restore · e edit · d delete · esc close"),
        width,
      ),
    );
    return out;
  }
}

export default function stash(pi: ExtensionAPI) {
  // Latest TUI context, for widget clicks. The widget factory closes over the
  // ctx that showed it, but clicks arriving later use this instead so they
  // survive session_start rebinding (same pattern as next-steps/footer).
  let liveCtx: ExtensionContext | undefined;
  // Re-entrancy guard: a click while the manager is already open is swallowed.
  let managerOpen = false;

  const updateWidget = (ctx: ExtensionContext, stack: StashEntry[]) => {
    if (!ctx.hasUI) return;
    liveCtx = ctx;
    if (stack.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const latest = stack[stack.length - 1]!;
    const firstLine = latest.text.split("\n")[0] ?? "";
    const preview =
      firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    const countText = stack.length > 1 ? ` (+${stack.length - 1} more)` : "";
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      // Click zone, recomputed every render from the unstyled widths (same
      // pattern as next-steps/footer chips).
      let end = 0;
      return {
        invalidate() {},
        render(width: number): string[] {
          if (width <= 0) return [];
          const prefix = "⧉ stashed: ";
          const body = `${preview}${countText}`;
          const hint = " · click or /stash";
          end = visibleWidth(prefix) + visibleWidth(body) + visibleWidth(hint);
          return [
            truncateToWidth(
              `${theme.fg("accent", prefix)}${theme.fg("muted", body)}${theme.fg("dim", hint)}`,
              width,
            ),
          ];
        },
        handleMouse(event: { type: string; button: string; x: number }) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          if (event.x < 0 || event.x >= end) return undefined;
          const live = liveCtx;
          if (!live?.hasUI || managerOpen) return { handled: true };
          managerOpen = true;
          openManager(live)
            .catch((err: unknown) => {
              try {
                live.ui.notify(
                  `Stash: ${err instanceof Error ? err.message : err}`,
                  "error",
                );
              } catch {
                // session is gone; nothing to tell
              }
            })
            .finally(() => {
              managerOpen = false;
            });
          return { handled: true };
        },
      };
    });
  };

  const openManager = async (ctx: ExtensionContext): Promise<void> => {
    const stack = stackFor(ctx);
    // Loop: editing (or escaping an edit) returns to the list. Only
    // restore, empty, or esc leaves the manager.
    for (;;) {
      if (stack.length === 0) {
        updateWidget(ctx, stack);
        return;
      }
      const result = await ctx.ui.custom<StashAction | undefined>(
        (tui, theme, _keybindings, done) =>
          new StashPanel({
            tui: tui as unknown as PanelDeps["tui"],
            theme,
            getStack: () => stackFor(ctx),
            done: (value) => done(value),
          }) as never,
      );

      if (result === undefined) {
        updateWidget(ctx, stack);
        if (stack.length === 0) ctx.ui.notify("All stashes deleted.", "info");
        return;
      }

      if (result.action === "restore") {
        const i = stack.findIndex((entry) => entry.id === result.id);
        if (i < 0) {
          ctx.ui.notify("That stash is already gone.", "warning");
          return;
        }
        const [entry] = stack.splice(i, 1);
        // Swap, don't clobber: park the current draft back on the stack.
        const current = ctx.ui.getEditorText();
        if (current.trim().length > 0) {
          stack.push({ id: newId(), text: current, ts: Date.now() });
        }
        ctx.ui.setEditorText(entry!.text);
        updateWidget(ctx, stack);
        return;
      }

      const entry = stack.find((item) => item.id === result.id);
      if (!entry) {
        continue; // gone (shouldn't happen); back to the list
      }
      const edited = await ctx.ui.editor("Edit stash", entry.text);
      if (edited === undefined) {
        continue; // escaped the edit; back to the list
      }
      if (edited.trim().length === 0) {
        stack.splice(stack.indexOf(entry), 1);
        updateWidget(ctx, stack);
        if (stack.length === 0) {
          ctx.ui.notify("All stashes deleted.", "info");
          return;
        }
        ctx.ui.notify("Stash deleted.", "info");
        continue;
      }
      entry.text = edited;
      updateWidget(ctx, stack);
      // saved; back to the list
    }
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
        stack.push({ id: newId(), text, ts: Date.now() });
        ctx.ui.setEditorText("");
      } else if (stack.length > 0) {
        ctx.ui.setEditorText(stack.pop()!.text);
      }
      updateWidget(ctx, stack);
    },
  });

  pi.registerCommand("stash", {
    description: "List, reorder, restore, or edit stashed prompts",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("stash needs the interactive TUI.", "error");
        return;
      }
      if (stackFor(ctx).length === 0) {
        ctx.ui.notify("No stashed messages — type something and hit ctrl+s to stash it.", "info");
        return;
      }
      await openManager(ctx);
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  // After a message is submitted, auto-restore the most recent stash into
  // the now-empty editor (mirrors Claude Code's behavior).
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const stack = stackFor(ctx);
    if (stack.length === 0) return;
    if (ctx.ui.getEditorText().trim().length > 0) return;
    ctx.ui.setEditorText(stack.pop()!.text);
    updateWidget(ctx, stack);
  });
}
