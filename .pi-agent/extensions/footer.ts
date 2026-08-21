/**
 * Minimal footer/statusline for pi — a lean replacement for the pi-footer package.
 *
 * Renders one line:
 *   dir provider model thinking branch +s ±u ?n ctx/window $cost [inline statuses]  session-name
 * plus an optional dim row of other extension statuses (from ctx.ui.setStatus).
 *
 * Design notes:
 * - No config UI, no widget registry: the layout is this file.
 * - Git state comes from a single `git status --porcelain=v1` per refresh, cached
 *   with a 5s TTL and refreshed asynchronously (stale-while-revalidate), so a slow
 *   repo never blocks a render.
 * - Colors are plain ANSI-16 SGR codes; only the extension-status row uses the theme.
 */

import { basename } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const GIT_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 1_000;

/** Statuses rendered inline in the main line (in this order) instead of the status row. */
const INLINE_STATUS_KEYS = ["codex-window", "copilot-window"] as const;

/** Providers whose cost is meaningless (subscription-billed). */
const HIDE_COST_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

const BLUE = 34;
const MAGENTA = 35;
const CYAN = 36;
const GREEN = 32;
const YELLOW = 33;
const RED = 31;
const BRIGHT_YELLOW = 93;

/** Short names for verbose provider ids. */
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "or",
  "github-copilot": "copilot",
  "openai-codex": "oai",
  baseten: "b10",
};

/** Short names for thinking levels (pi: off|minimal|low|medium|high|xhigh|max). */
const THINKING_NAMES: Record<string, string> = {
  minimal: "min",
  low: "lo",
  medium: "med",
  high: "hi",
  xhigh: "xhi",
};

/** Ordered rewrite rules for verbose model ids; first match wins. Results are lowercased. */
const MODEL_RULES: Array<[RegExp, string]> = [
  [/^stealth\/ox-alpha$/i, "ox"],
  [/^gpt-[\d.]+-sol$/i, "sol"],
  [/^claude-(.+)$/i, "$1"],
  [/^moonshotai\/Kimi-(.+)$/i, "$1"],
  [/^deepseek-ai\/DeepSeek-(V\d+)-([A-Za-z]+)(?:-\d+)?$/i, "DS $1-$2"],
  [/^Qwen([\d.]+-\d+B(?:-A\d+B)?)\b.*$/i, "$1"],
];

interface GitState {
  isRepo: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

const EMPTY_GIT: GitState = { isRepo: false, staged: 0, unstaged: 0, untracked: 0 };

/** Stale-while-revalidate git status: renders never await, they just trigger a repaint. */
class GitStatusCache {
  private state: GitState = EMPTY_GIT;
  private key = "";
  private fetchedAt = 0;
  private inFlight = false;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  read(cwd: string, requestRender: () => void): GitState {
    if (cwd !== this.key) {
      this.key = cwd;
      this.state = EMPTY_GIT;
      this.fetchedAt = 0;
    }
    if (!this.inFlight && Date.now() - this.fetchedAt >= GIT_TTL_MS) {
      void this.refresh(cwd, requestRender);
    }
    return this.state;
  }

  private async refresh(cwd: string, requestRender: () => void): Promise<void> {
    this.inFlight = true;
    let next = EMPTY_GIT;
    try {
      const { stdout, code, killed } = await this.pi.exec(
        "git",
        ["status", "--porcelain=v1"],
        { cwd, timeout: GIT_TIMEOUT_MS },
      );
      // trimEnd, not trim: columns 1/2 encode staged vs unstaged, so a leading
      // space on the first line is significant.
      if (code === 0 && !killed) next = parsePorcelain(stdout.trimEnd());
    } catch {
      next = EMPTY_GIT;
    } finally {
      this.inFlight = false;
    }
    // A cwd change mid-flight invalidates this result.
    if (cwd !== this.key) return;
    const changed = !sameGit(this.state, next);
    this.state = next;
    this.fetchedAt = Date.now();
    if (changed) requestRender();
  }
}

function sameGit(a: GitState, b: GitState): boolean {
  return (
    a.isRepo === b.isRepo &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.untracked === b.untracked
  );
}

function parsePorcelain(output: string): GitState {
  const state: GitState = { isRepo: true, staged: 0, unstaged: 0, untracked: 0 };
  if (!output) return state;
  for (const line of output.split("\n")) {
    if (line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      state.untracked += 1;
      continue;
    }
    if (x && x !== " ") state.staged += 1;
    if (y && y !== " ") state.unstaged += 1;
  }
  return state;
}

function color(code: number, text: string): string {
  return text ? `\x1b[${code}m${text}\x1b[39m` : "";
}

function shortProvider(provider: string | undefined): string {
  if (!provider) return "";
  return PROVIDER_NAMES[provider] ?? provider;
}

function shortModel(model: string | undefined): string {
  if (!model) return "no-model";
  for (const [pattern, replacement] of MODEL_RULES) {
    // Aliased ids render lowercase; unknown ids pass through with their original casing.
    if (pattern.test(model)) return model.replace(pattern, replacement).toLowerCase();
  }
  return model;
}

function shortThinking(level: string): string {
  return THINKING_NAMES[level] ?? level;
}

/** 0 → "0", 12_300 → "12.3k", 1_000_000 → "1m" (pi-footer's "default" token format). */
function formatCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${trimFixed(value / 1_000, 1)}k`;
  return `${trimFixed(value / 1_000_000, 1)}m`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

interface UsageLike {
  cost?: { total?: unknown };
}

/** Sum assistant-message cost across the active branch. */
function sessionCost(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) {
    const message = (entry as { message?: { role?: unknown; usage?: unknown } })?.message;
    if (!message || message.role !== "assistant") continue;
    const value = (message.usage as UsageLike | undefined)?.cost?.total;
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

function contextColorCode(tokens: number | null | undefined, window: number | undefined): number {
  if (tokens == null || !window) return CYAN;
  const percent = Math.min(100, Math.max(0, (tokens / window) * 100));
  if (percent >= CONTEXT_DANGER_PERCENT) return RED;
  if (percent >= CONTEXT_WARNING_PERCENT) return YELLOW;
  return CYAN;
}

export default function footerExtension(pi: ExtensionAPI): void {
  const git = new GitStatusCache(pi);
  let enabled = true;

  function apply(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);

      return {
        dispose: unsubscribe,
        invalidate(): void {},
        render(width: number): string[] {
          if (width <= 0) return [];

          const provider = ctx.model?.provider;
          const usage = ctx.getContextUsage();
          const gitState = git.read(ctx.cwd, requestRender);
          const branch = footerData.getGitBranch();
          const statuses = footerData.getExtensionStatuses();

          const left: string[] = [
            color(BLUE, basename(ctx.cwd)),
            color(BRIGHT_YELLOW, shortProvider(provider)),
            color(BRIGHT_YELLOW, shortModel(ctx.model?.id)),
            color(BRIGHT_YELLOW, ctx.model?.reasoning ? shortThinking(pi.getThinkingLevel()) : ""),
            color(MAGENTA, branch ?? ""),
            color(
              MAGENTA,
              gitState.isRepo
                ? `+${gitState.staged} ±${gitState.unstaged} ?${gitState.untracked}`
                : "",
            ),
            // context-length / context-window share one segment (no spaces around "/")
            `${color(
              contextColorCode(usage?.tokens, usage?.contextWindow),
              usage?.tokens == null ? "?" : formatCount(usage.tokens),
            )}/${color(CYAN, usage?.contextWindow ? formatCount(usage.contextWindow) : "?")}`,
            provider && HIDE_COST_PROVIDERS.has(provider)
              ? ""
              : color(GREEN, formatCost(sessionCost(ctx.sessionManager.getBranch()))),
            ...INLINE_STATUS_KEYS.map((key) => statuses.get(key) ?? ""),
          ];

          const leftLine = left.filter(Boolean).join(" ");
          const right = pi.getSessionName();
          const mainLine = right
            ? padBetween(leftLine, color(CYAN, right), width)
            : truncateToWidth(leftLine, width, "…");

          const extra: string[] = [];
          for (const [key, value] of statuses) {
            if (!value || (INLINE_STATUS_KEYS as readonly string[]).includes(key)) continue;
            extra.push(value);
          }
          if (extra.length === 0) return [mainLine];
          return [mainLine, truncateToWidth(theme.fg("dim", extra.join(" ")), width, "…")];
        },
      };
    });
  }

  function padBetween(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…");
  }

  pi.registerCommand("footer", {
    description: "Toggle the custom footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      apply(ctx);
      ctx.ui.notify(enabled ? "footer enabled" : "footer disabled", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => apply(ctx));
  pi.on("model_select", async (_event, ctx) => apply(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
  });
}
