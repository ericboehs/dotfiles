/**
 * Minimal footer/statusline for pi — a lean replacement for the pi-footer package.
 *
 * Renders one line:
 *   dir provider model thinking branch* ⇣⇡ ctx/window $cost [inline statuses] ⚡boot bypass   session-name
 * plus an optional dim row of other extension statuses (from ctx.ui.setStatus).
 * The boot timer shows until the first message; "bypass" replaces it as the
 * right-most main-line marker while Approval Guardian is bypassed.
 *
 * Design notes:
 * - No config UI, no widget registry: the layout is this file.
 * - Git state comes from a single `git status --porcelain=v1` per refresh, cached
 *   with a 5s TTL and refreshed asynchronously (stale-while-revalidate), so a slow
 *   repo never blocks a render.
 * - Colors are plain ANSI-16 SGR codes; the theme supplies only the dim
 *   foreground, shared by the boot timer, the peer session name, and the
 *   extension-status row.
 */

import { spawn } from "node:child_process";
import { appendFile, readFile, realpath, stat, writeFile, access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const GIT_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 1_000;

/**
 * pi-claude-link registers this process in Claude Code's peer registry and
 * derives a name ("pi-dotfiles") when the session has none. That name is what
 * other agents address, so it is worth showing — dimmed, to distinguish it
 * from a session name the user actually chose.
 */
const PEER_TTL_MS = 5_000;
// pi-claude-link registers after session_start and may rename itself moments
// later to dodge a collision, so poke the cache instead of waiting for a render.
const PEER_SETTLE_DELAYS_MS = [300, 1_000, 3_000, 8_000];

/** How often to re-read pi's on-disk version looking for an upgrade while running. */
const UPDATE_TTL_MS = 30_000;

/** Where the background bundle rebuild appends its output. */
const AUTO_BUNDLE_LOG = "auto-bundle.log";
/** Concurrent detections across pi instances serialize on this lock directory. */
const AUTO_BUNDLE_LOCK = "pi-bundle.lock";
/** A lock older than this is stale (a crashed run never cleaned up) and gets stolen. */
const AUTO_BUNDLE_LOCK_STALE_MIN = 10;

/** Statuses rendered inline in the main line (in this order) instead of the status row. */
const INLINE_STATUS_KEYS = ["codex-window", "copilot-window"] as const;

/**
 * The boot timer sits in the footer until the first message goes out, and every
 * cold start is appended to `boot-times.jsonl` so `/boot stats` can show whether
 * a change actually moved the needle or just felt like it did.
 *
 * Measured at the footer's first render, which is the last thing to happen in
 * `interactiveMode.init()` — so `process.uptime()` there is genuinely
 * exec-to-first-paint, node bootstrap and extension loading included. Run
 * `PI_TIMING=1 PI_STARTUP_BENCHMARK=1 pi` for the phase-by-phase breakdown.
 */
const BOOT_LOG_FILE = "boot-times.jsonl";
const BOOT_STATS_DEFAULT = 50;
/** Trim to this many records once the log crosses the size check below. */
const BOOT_LOG_KEEP = 1_000;
const BOOT_LOG_MAX_BYTES = 200_000;

/** Providers whose cost is meaningless (subscription-billed). */
const HIDE_COST_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

/** pi-approval-guardian's persistent below-editor warning, replaced by our marker. */
const GUARDIAN_COMMAND = "approval-guardian";
const GUARDIAN_WIDGET_KEY = "approval-guardian-bypass";
// The guardian awaits waitForIdle() before painting, so a single clear races it.
const GUARDIAN_CLEAR_DELAYS_MS = [100, 600, 2_500];

const BLUE = 34;
const MAGENTA = 35;
const CYAN = 36;
const GREEN = 32;
const YELLOW = 33;
const RED = 31;
const BRIGHT_YELLOW = 93;
const BRIGHT_RED = 91;

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
  dirty: boolean;
  ahead: boolean;
  behind: boolean;
}

const EMPTY_GIT: GitState = { isRepo: false, dirty: false, ahead: false, behind: false };

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
      // Both run concurrently: rev-list is wasted work outside a repo or
      // without an upstream, but it costs nothing next to a serial round trip.
      const [status, revList] = await Promise.all([
        this.pi.exec("git", ["status", "--porcelain=v1"], { cwd, timeout: GIT_TIMEOUT_MS }),
        this.pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
        }),
      ]);
      if (status.code === 0 && !status.killed) {
        next = {
          isRepo: true,
          // Any staged, unstaged or untracked path counts as dirty, matching
          // p10k's vcs-detect-changes + git-untracked hooks.
          dirty: status.stdout.trim().length > 0,
          // Detached HEAD or no upstream configured: rev-list exits non-zero.
          ...parseAheadBehind(revList.code === 0 && !revList.killed ? revList.stdout : ""),
        };
      }
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
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}

/** `rev-list --left-right --count @{upstream}...HEAD` prints "<behind>\t<ahead>". */
function parseAheadBehind(output: string): Pick<GitState, "ahead" | "behind"> {
  const [behind = 0, ahead = 0] = output.trim().split(/\s+/).map(Number);
  return { ahead: ahead > 0, behind: behind > 0 };
}

/** Same stale-while-revalidate shape as the git cache, over one small JSON read. */
class PeerNameCache {
  private name = "";
  private fetchedAt = 0;
  private inFlight = false;

  read(requestRender: () => void): string {
    if (!this.inFlight && Date.now() - this.fetchedAt >= PEER_TTL_MS) {
      void this.refresh(requestRender);
    }
    return this.name;
  }

  /** Re-read now, ignoring the TTL. */
  reload(requestRender: () => void): void {
    if (!this.inFlight) void this.refresh(requestRender);
  }

  private async refresh(requestRender: () => void): Promise<void> {
    this.inFlight = true;
    let next = "";
    try {
      // Resolved per read, not at module load, so a HOME change is picked up.
      const file = join(homedir(), ".claude", "sessions", `${process.pid}.json`);
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      const name = (parsed as { name?: unknown } | null)?.name;
      if (typeof name === "string") next = name;
    } catch {
      // No pi-claude-link, no registry, or a half-written file: show nothing.
      next = "";
    } finally {
      this.inFlight = false;
    }
    const changed = this.name !== next;
    this.name = next;
    this.fetchedAt = Date.now();
    if (changed) requestRender();
  }
}

/**
 * Claude-style update notice: remember the version this process booted with,
 * then watch the on-disk version; a mismatch means an install landed while we
 * run old code and only a restart picks it up.
 *
 * The boot version is stashed on globalThis (keyed per process) so /reload —
 * which re-executes this module against the already-updated files on disk —
 * doesn't reset the baseline and silently clear a still-valid notice.
 */
class UpdateCheckCache {
  private bootVersion = "";
  private current = "";
  private fetchedAt = 0;
  private inFlight = false;

  async init(): Promise<void> {
    const stash = globalThis as { __piFooterBootVersion?: string };
    if (stash.__piFooterBootVersion !== undefined) {
      this.bootVersion = stash.__piFooterBootVersion;
      return;
    }
    this.bootVersion = await piVersion();
    stash.__piFooterBootVersion = this.bootVersion;
    this.current = this.bootVersion;
  }

  read(requestRender: () => void): boolean {
    if (!this.bootVersion) return false;
    if (!this.inFlight && Date.now() - this.fetchedAt >= UPDATE_TTL_MS) {
      void this.refresh(requestRender);
    }
    return this.current !== this.bootVersion;
  }

  /** Re-read now, ignoring the TTL (used by the idle-session poll timer). */
  reload(requestRender: () => void): void {
    if (this.bootVersion && !this.inFlight) void this.refresh(requestRender);
  }

  private async refresh(requestRender: () => void): Promise<void> {
    this.inFlight = true;
    let next = this.current;
    try {
      next = (await piVersion()) || this.current;
    } finally {
      this.inFlight = false;
    }
    const changed = this.current !== next;
    this.current = next;
    this.fetchedAt = Date.now();
    if (changed && next !== this.bootVersion) void rebuildBundle(next).catch(() => {});
    if (changed) requestRender();
  }
}

/**
 * p10k-lean git summary: "master", "master*", "master ⇣⇡", "master* ⇡".
 *
 * Mirrors ~/.p10k.zsh — DIRTY_ICON='*' glued to the branch, blank
 * staged/unstaged/untracked icons, and unnumbered ⇣/⇡ arrows.
 */
function formatGit(branch: string | null, state: GitState): string {
  if (!branch) return "";
  const arrows = `${state.behind ? "⇣" : ""}${state.ahead ? "⇡" : ""}`;
  return `${color(MAGENTA, `${branch}${state.dirty ? "*" : ""}`)}${arrows ? ` ${color(CYAN, arrows)}` : ""}`;
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

/** 903 → "903ms", 1240 → "1.24s". */
function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(2)}s`;
}

function bootLogPath(): string {
  // Resolved per call, not at module load, so a HOME change is picked up.
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), BOOT_LOG_FILE);
}

/**
 * pi's package.json, resolved fresh on every call. argv[1] is usually a bin
 * symlink (mise shim -> ../lib/node_modules/.../dist/cli.js), so resolve it
 * before walking up to the package root — and re-resolve per read, so an
 * update that repoints the symlink (or swaps the tree underneath it) is seen.
 */
async function piPackageJsonPath(): Promise<string | null> {
  try {
    const entry = process.argv[1];
    if (!entry) return null;
    const resolved = await realpath(entry);
    return join(dirname(dirname(resolved)), "package.json");
  } catch {
    return null;
  }
}

/** pi's own version, for correlating a regression with an upgrade. */
async function piVersion(): Promise<string> {
  try {
    const file = await piPackageJsonPath();
    if (!file) return "";
    const pkg: unknown = JSON.parse(await readFile(file, "utf8"));
    const version = (pkg as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

/** ~/bin/pi-bundle (bin/ is symlinked there), or null when it's not installed. */
async function piBundleScript(): Promise<string | null> {
  const candidate = join(homedir(), "bin", "pi-bundle");
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function autoBundleAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * A pi update leaves dist/bundle.mjs stale and the bin at stock cli.js, so
 * every launch runs ~115ms slower until someone re-runs pi-bundle. This footer
 * is already the first to know about an update — so let it kick off the
 * rebuild in a detached background process.
 *
 * Runs once per detected version (globalThis guard survives /reload), honors
 * PI_NO_AUTO_BUNDLE=1, serializes concurrent detections from other pi
 * instances on a lock directory, and appends everything to auto-bundle.log.
 */
async function rebuildBundle(version: string): Promise<void> {
  const stash = globalThis as { __piFooterAutoBundleFor?: string };
  if (stash.__piFooterAutoBundleFor === version) return;
  stash.__piFooterAutoBundleFor = version;
  if (process.env.PI_NO_AUTO_BUNDLE) return;

  const script = await piBundleScript();
  if (!script) return;

  const agentDir = autoBundleAgentDir();
  // Redirect by path, not by inherited fd: Node opens files with O_CLOEXEC,
  // so fd numbers from this process don't exist in the detached child.
  const logPath = join(agentDir, AUTO_BUNDLE_LOG);
  const lockPath = join(agentDir, AUTO_BUNDLE_LOCK);
  const sh = [
    `lock=${JSON.stringify(lockPath)}`,
    `log=${JSON.stringify(logPath)}`,
    `if ! mkdir "$lock" 2>/dev/null; then`,
    `  if [ -z "$(find "$lock" -maxdepth 0 -mmin -${AUTO_BUNDLE_LOCK_STALE_MIN} 2>/dev/null)" ]; then`,
    `    rm -rf "$lock" && mkdir "$lock" || exit 0`,
    `  else`,
    `    exit 0`,
    `  fi`,
    `fi`,
    `trap 'rm -rf "$lock"' EXIT`,
    `echo "=== auto-rebuild for ${version} at $(date) (pid $$)" >> "$log"`,
    `${JSON.stringify(script)} >> "$log" 2>&1`,
  ].join("\n");
  const child = spawn("/bin/sh", ["-c", sh], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
}

/**
 * Append one cold start. Never awaited by a render — blocking first paint to
 * record how slow first paint was would be its own punchline.
 */
async function recordBoot(ms: number, cwd: string): Promise<void> {
  const file = bootLogPath();
  await appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ms, v: await piVersion(), cwd })}\n`);
  // Concurrent pi processes can race this and drop a line or two. Fine: it is a
  // trend log, not an audit log.
  const { size } = await stat(file);
  if (size <= BOOT_LOG_MAX_BYTES) return;
  const kept = (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-BOOT_LOG_KEEP);
  await writeFile(file, `${kept.join("\n")}\n`);
}

async function readBoots(limit: number): Promise<number[]> {
  const out: number[] = [];
  for (const line of (await readFile(bootLogPath(), "utf8")).split("\n")) {
    if (!line) continue;
    try {
      const ms = (JSON.parse(line) as { ms?: unknown }).ms;
      if (typeof ms === "number" && Number.isFinite(ms)) out.push(ms);
    } catch {
      // Half-written line from a racing process.
    }
  }
  return out.slice(-limit);
}

/** Nearest-rank percentile over an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
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
  const peer = new PeerNameCache();
  const update = new UpdateCheckCache();
  void update.init().catch(() => {});
  let enabled = true;
  let bypassed = false;
  let repaint: (() => void) | undefined;
  // Only a cold start has a boot time worth showing; after /reload or a session
  // switch, uptime is however long the process has been sitting there.
  let coldStart = false;
  let bootMs: number | undefined;
  let bootCleared = false;
  let updateTimerStarted = false;

  function apply(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      repaint = requestRender;

      return {
        dispose: () => {
          unsubscribe();
          repaint = undefined;
        },
        invalidate(): void {},
        render(width: number): string[] {
          if (width <= 0) return [];

          const provider = ctx.model?.provider;
          const usage = ctx.getContextUsage();
          const gitState = git.read(ctx.cwd, requestRender);
          const branch = footerData.getGitBranch();
          const statuses = footerData.getExtensionStatuses();

          if (coldStart && bootMs === undefined) {
            bootMs = Math.round(process.uptime() * 1_000);
            void recordBoot(bootMs, ctx.cwd).catch(() => {});
          }
          const showBoot = bootMs !== undefined && !bootCleared;
          const updated = update.read(requestRender);

          const left: string[] = [
            color(BLUE, basename(ctx.cwd)),
            color(BRIGHT_YELLOW, shortProvider(provider)),
            color(BRIGHT_YELLOW, shortModel(ctx.model?.id)),
            color(BRIGHT_YELLOW, ctx.model?.reasoning ? shortThinking(pi.getThinkingLevel()) : ""),
            formatGit(branch, gitState),
            // context-length / context-window share one segment (no spaces around "/")
            `${color(
              contextColorCode(usage?.tokens, usage?.contextWindow),
              usage?.tokens == null ? "?" : formatCount(usage.tokens),
            )}/${color(CYAN, usage?.contextWindow ? formatCount(usage.contextWindow) : "?")}`,
            provider && HIDE_COST_PROVIDERS.has(provider)
              ? ""
              : color(GREEN, formatCost(sessionCost(ctx.sessionManager.getBranch()))),
            ...INLINE_STATUS_KEYS.map((key) => statuses.get(key) ?? ""),
            showBoot ? theme.fg("dim", `⚡${formatMs(bootMs as number)}`) : "",
            updated ? color(GREEN, "Update installed · Restart to update") : "",
            // Last before the flex gap, so it sits closest to the right edge.
            bypassed ? color(BRIGHT_RED, "bypass") : "",
          ];

          const leftLine = left.filter(Boolean).join(" ");
          // Fall back to the name other agents use to reach this session.
          const sessionName = pi.getSessionName();
          const peerName = sessionName ? "" : peer.read(requestRender);
          const right =
            sessionName ? color(CYAN, sessionName)
            : peerName ? theme.fg("dim", peerName)
            : "";
          const mainLine =
            sessionName || peerName ?
              padBetween(leftLine, right, width)
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

  /**
   * Take over the guardian's persistent below-editor warning.
   *
   * The guardian refuses to bypass outside the TUI so its warning stays
   * visible; the footer marker is just as persistent, so the property holds —
   * but only while the footer is on, hence the `enabled` guard.
   */
  function suppressGuardianWidget(ctx: ExtensionCommandContext): void {
    if (!enabled || !ctx.hasUI) return;
    for (const delay of GUARDIAN_CLEAR_DELAYS_MS) {
      setTimeout(() => {
        if (bypassed && enabled) ctx.ui.setWidget(GUARDIAN_WIDGET_KEY, undefined);
      }, delay).unref?.();
    }
  }

  pi.registerCommand("bypass", {
    description: "Toggle Approval Guardian bypass, shown in the footer",
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      const next =
        argument === "on" ? true
        : argument === "off" ? false
        : argument === "" ? !bypassed
        : undefined;
      if (next === undefined) {
        ctx.ui.notify("Usage: /bypass [on|off]", "warning");
        return;
      }
      if (next === bypassed) {
        ctx.ui.notify(`Approval Guardian is already ${next ? "bypassed" : "enabled"}`, "info");
        return;
      }
      if (!pi.getCommands().some((command) => command.name === GUARDIAN_COMMAND)) {
        // Without the guardian loaded this would go to the LLM as a plain message.
        ctx.ui.notify(`/${GUARDIAN_COMMAND} is not available`, "error");
        return;
      }

      bypassed = next;
      pi.sendUserMessage(`/${GUARDIAN_COMMAND} ${next ? "bypass" : "enable"}`, {
        expandPromptTemplates: true,
      });
      if (next) suppressGuardianWidget(ctx);
      repaint?.();
    },
  });

  pi.registerCommand("boot", {
    description: "Show this launch's boot time, or /boot stats [n] for recent launches",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (/^stats\b/.test(argument)) {
        const requested = Number.parseInt(argument.slice("stats".length).trim(), 10);
        const limit = Number.isFinite(requested) && requested > 0 ? requested : BOOT_STATS_DEFAULT;
        let boots: number[] = [];
        try {
          boots = await readBoots(limit);
        } catch {
          // No log yet.
        }
        if (boots.length === 0) {
          ctx.ui.notify("No boot times recorded yet", "warning");
          return;
        }
        const sorted = [...boots].sort((a, b) => a - b);
        ctx.ui.notify(
          `${boots.length} launches · p50 ${formatMs(percentile(sorted, 50))}` +
            ` · p95 ${formatMs(percentile(sorted, 95))}` +
            ` · min ${formatMs(sorted[0] ?? 0)} · max ${formatMs(sorted[sorted.length - 1] ?? 0)}` +
            (bootMs === undefined ? "" : ` · this one ${formatMs(bootMs)}`),
          "info",
        );
        return;
      }

      const uptime = formatMs(Math.round(process.uptime() * 1_000));
      ctx.ui.notify(
        bootMs === undefined ?
          `Up ${uptime} (boot not measured — footer was off at launch)`
        : `Booted in ${formatMs(bootMs)}, up ${uptime}. Trend: /boot stats · Breakdown: PI_TIMING=1 PI_STARTUP_BENCHMARK=1 pi`,
        "info",
      );
    },
  });

  pi.registerCommand("footer", {
    description: "Toggle the custom footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      apply(ctx);
      ctx.ui.notify(enabled ? "footer enabled" : "footer disabled", "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    // The guardian's bypass resets when the session runtime reloads.
    bypassed = false;
    coldStart = event.reason === "startup";
    apply(ctx);
    // Renders are event-driven, so an idle footer would otherwise miss a peer
    // name that lands after the last startup paint — until the next keystroke.
    for (const delay of PEER_SETTLE_DELAYS_MS) {
      setTimeout(() => peer.reload(() => repaint?.()), delay).unref?.();
    }
    // Renders are event-driven, so an idle session would never re-read the
    // version; poll so a pi upgrade surfaces like Claude's update notice.
    // session_start also fires on session switches — only start one timer.
    if (!updateTimerStarted) {
      updateTimerStarted = true;
      const updateTimer = setInterval(() => update.reload(() => repaint?.()), UPDATE_TTL_MS);
      updateTimer.unref?.();
    }
  });
  // Retire the boot timer the moment a message is sent. Extension commands are
  // matched before this event, so /boot and /footer leave it alone; messages
  // this extension sends itself arrive as source "extension" and do too.
  pi.on("input", async (event) => {
    if (bootCleared || event.source !== "interactive") return undefined;
    bootCleared = true;
    repaint?.();
    return undefined;
  });

  pi.on("model_select", async (_event, ctx) => apply(ctx));

  pi.on("model_select", async (_event, ctx) => apply(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
  });
}
