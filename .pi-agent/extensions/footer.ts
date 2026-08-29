/**
 * Minimal footer/statusline for pi — a lean replacement for the pi-footer package.
 *
 * Renders a main line:
 *   dir provider model thinking branch* ⇣⇡ ctx/window $cost [inline statuses] ⚡boot bypass   session-name
 * plus an optional dim row of other extension statuses (from ctx.ui.setStatus).
 * A pending-update notice is a separate right-aligned widget above the prompt.
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
import { appendFile, readFile, realpath, writeFile, access, constants } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  VERSION as RUNNING_PI_VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

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
const INLINE_STATUS_KEYS = ["codex-window", "copilot-window", "grok-window"] as const;

/**
 * The boot timer sits in the footer until the first message goes out, and every
 * cold start is appended to `boot-times.jsonl` so `/boot stats` can show whether
 * a change actually moved the needle or just felt like it did.
 *
 * Measured at the footer's first render, which is the last thing to happen in
 * `interactiveMode.init()` — so `process.uptime()` there is genuinely
 * exec-to-first-paint, node bootstrap and extension loading included. Run
 * `PI_TIMING=1 PI_STARTUP_BENCHMARK=1 pi` for the phase-by-phase breakdown.
 *
 * Each record also carries `since` (seconds since the previous cold start) and
 * `load` (1-minute load average at first paint). Without them the log is not
 * interpretable: relaunching pi a few times in a row runs ~300ms faster than a
 * one-off launch, purely from a warm page cache and an idle machine, so a
 * benchmark burst and a real launch look like a regression sitting next to a
 * fix. `/boot stats` splits the two cohorts on BOOT_BURST_WINDOW_S.
 */
const BOOT_LOG_FILE = "boot-times.jsonl";
const BOOT_STATS_DEFAULT = 50;
/** Launches this close to the previous one are "burst": warm cache, same sitting. */
const BOOT_BURST_WINDOW_S = 70;
/** Trim to this many records once the log crosses the size check below. */
const BOOT_LOG_KEEP = 1_000;
const BOOT_LOG_MAX_BYTES = 200_000;

/** Providers whose cost is meaningless (subscription-billed or local). */
const HIDE_COST_PROVIDERS = new Set(["openai-codex", "github-copilot", "omlx"]);

/**
 * Usage chips written by baseten-usage.ts / openrouter-usage.ts via globalThis
 * stashes (color.ts's contract pattern — an import would be a hard dependency
 * and a missing extension aborts pi's launch). Replaces the session-cost slot:
 * session cost is meaningless against providers that bill monthly in aggregate.
 */
function usageChip(provider: string | undefined): string | undefined {
  const stashKey =
    provider === "baseten" ? "__piBasetenUsage"
    : provider === "openrouter" ? "__piOpenRouterUsage"
    : undefined;
  if (!stashKey) return undefined;
  const stash = (globalThis as Record<string, unknown>)[stashKey] as
    | { value?: unknown }
    | undefined;
  const value = stash?.value;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Short names for the upstream providers OpenRouter routes to, written by
 * openrouter-route.ts. Anything unmapped is squashed to lowercase alphanumerics
 * ("Parasail" → "parasail"), so a new provider still reads sensibly.
 */
const ROUTE_NAMES: Record<string, string> = {
  "z.ai": "z",
  baseten: "b10",
  cloudflare: "cf",
  deepinfra: "di",
  digitalocean: "do",
  gmicloud: "gmi",
  "io net": "ionet",
};

/**
 * Strip an OpenRouter preset suffix: `z-ai/glm-5.3-flash@preset/ox-alpha` is
 * the same model as `z-ai/glm-5.3-flash`, routed by a saved config. Also drops
 * a `:nitro`/`:floor` variant so aliases and route matching survive both.
 */
function baseModelId(model: string | undefined): string | undefined {
  return model?.replace(/@preset\/[^:]*/i, "").replace(/:[^/]+$/, "");
}

/** `novita/` for the model chip, or "" when the route is unknown or stale. */
function routePrefix(provider: string | undefined, modelId: string | undefined): string {
  if (provider !== "openrouter") return "";
  const route = (globalThis as Record<string, unknown>)["__piOpenRouterRoute"] as
    | { provider?: unknown; model?: unknown }
    | undefined;
  const name = route?.provider;
  if (typeof name !== "string" || !name) return "";
  // A route recorded for another model (picker switch mid-session) is not ours.
  // A preset resolves server-side, so compare the models it resolves between.
  const routed = route?.model;
  const current = baseModelId(modelId);
  if (typeof routed === "string" && current && baseModelId(routed) !== current) return "";
  const key = name.toLowerCase();
  const slug = ROUTE_NAMES[key] ?? key.replace(/[^a-z0-9]+/g, "");
  return slug ? `${slug}/` : "";
}

/** SuperGrok OAuth is subscription-billed; an xAI API key still has a real dollar cost. */
function hideSessionCost(provider: string | undefined, ctx: ExtensionContext): boolean {
  if (!provider) return false;
  if (HIDE_COST_PROVIDERS.has(provider)) return true;
  return provider === "xai" && ctx.model != null && ctx.modelRegistry.isUsingOAuth(ctx.model);
}

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

/** pi-approval-guardian's persistent below-editor warning, replaced by our marker. */
const GUARDIAN_COMMAND = "approval-guardian";
const GUARDIAN_WIDGET_KEY = "approval-guardian-bypass";
const GUARDIAN_BYPASS_CONTROL_EVENT = "approval-guardian:set-temporary-bypass";
const GUARDIAN_BYPASS_STATE_EVENT = "approval-guardian:temporary-bypass-state";
/** The pin that carries the control event; upstream npm builds do not have it. */
const GUARDIAN_FORK_PACKAGE = "git:github.com/ericboehs/pi-approval-guardian";

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
  "github-copilot": "gh",
  "openai-codex": "o",
  openai: "o",
  xai: "x",
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
  [/^gpt-[\d.]+-sol$/i, "sol"],
  [/^claude-(.+)$/i, "$1"],
  [/^moonshotai\/Kimi-(.+)$/i, "$1"],
  [/^deepseek-ai\/DeepSeek-(V\d+)-([A-Za-z]+)(?:-\d+)?$/i, "DS $1-$2"],
  [/^z-ai\/GLM-5\.3-Flash$/i, "oxa"],
  [/^zai-org\/GLM-5\.3-Flash$/i, "oxa"],
  [/^Ornith-1\.5-35B-A3B-MLX-4bit$/i, "orn-1.5"],
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
 * RUNNING_PI_VERSION comes from pi's already-loaded module, so /reload keeps
 * reporting the version this process is actually running even after the files
 * on disk have been replaced by an update.
 */
interface InstalledUpdate {
  from: string;
  to: string;
}

class UpdateCheckCache {
  private readonly bootVersion = RUNNING_PI_VERSION;
  private current = "";
  private fetchedAt = 0;
  private inFlight = false;

  async init(): Promise<void> {
    this.current = (await piVersion()) || this.bootVersion;
  }

  read(requestRender: () => void): InstalledUpdate | undefined {
    if (!this.bootVersion) return undefined;
    if (!this.inFlight && Date.now() - this.fetchedAt >= UPDATE_TTL_MS) {
      void this.refresh(requestRender);
    }
    return this.current && this.current !== this.bootVersion
      ? { from: this.bootVersion, to: this.current }
      : undefined;
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

function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * The SGR foreground /color painted the editor border with, or undefined when
 * no session color is set.
 *
 * Read out of color.ts's globalThis stash rather than imported from it. An
 * import is the same value but a hard dependency: pi aborts the whole launch
 * when an extension's import cannot resolve, so a host that has footer.ts but
 * not color.ts — which is exactly what a partially-applied extensions
 * directory looks like — gets no pi at all rather than an uncolored name.
 * The key is part of color.ts's contract; see its STASH_KEY.
 */
function sessionColorAnsi(): string | undefined {
  const stash = (globalThis as { __piSessionColor?: { ansi?: string } }).__piSessionColor;
  return stash?.ansi;
}

/** Wrap text in a ready-made SGR foreground sequence (from /color). */
function paint(ansi: string, text: string): string {
  return text ? `${ansi}${text}\x1b[39m` : "";
}

/** Widget keys, so the footer toggle and shutdown can clear both additions. */
const SCROLLBACK_WIDGET_KEY = "footer-scrollback";
const UPDATE_WIDGET_KEY = "footer-update";

/**
 * Centered "↓ scrolled" banner rendered directly above the editor while the
 * transcript viewport is parked above the bottom.
 *
 * Fullscreen mode only: in regular mode the terminal owns the scrollback
 * buffer, so pi has no idea where the user is scrolled. Scrolling calls
 * requestRender() internally, so reading the flag here updates live — no
 * polling needed. isFollowingOutput lives on TuiAltScreen rather than the
 * base TUI interface extensions are handed, hence the runtime shape check
 * instead of a blind cast.
 */
/** Shared counter for assistant messages that arrived while scrolled up. */
interface ScrollbackState {
  unseen: number;
}

function scrollbackWidget(tui: TUI, state: ScrollbackState): Component {
  return {
    invalidate(): void {},
    render(width: number): string[] {
      if (tui.mode !== "fullscreen") return [];
      const alt = tui as TUI & { isFollowingOutput?: boolean };
      if (alt.isFollowingOutput !== false) {
        // Back at the bottom: everything has been seen.
        state.unseen = 0;
        return [];
      }
      const count = state.unseen;
      const noun = count === 1 ? "message" : "messages";
      const text = color(
        YELLOW,
        count > 0
          ? `${count} new ${noun} · ${SCROLLBACK_CLICK_LABEL}`
          : `scrolled · ${SCROLLBACK_CLICK_LABEL}`,
      );
      const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
      return [`${" ".repeat(pad)}${text}`];
    },
  };
}

/** SGR left-button press: \x1b[<0;COL;ROWM (release is the same with trailing m). */
const MOUSE_PRESS_RE = /\x1b\[<0;(\d+);(\d+)M/g;

/** Trailing half of the banner text, used to locate its row in the last frame. */
const SCROLLBACK_CLICK_LABEL = "click to return \u2193";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Hit test for the banner: the click has to land on the banner's own row and
 * within its printed characters. Anything else — including a press that starts
 * a text selection in the transcript — is left alone.
 */
function isBannerHit(screen: string[] | undefined, col: number, row: number): boolean {
  const line = screen?.[row];
  if (!line) return false;
  const plain = line.replace(ANSI_RE, "");
  if (!plain.includes(SCROLLBACK_CLICK_LABEL)) return false;
  const start = plain.length - plain.trimStart().length;
  const end = plain.trimEnd().length;
  return col >= start && col < end;
}

function attachScrollbackClick(tui: TUI): () => void {
  // TuiAltScreen installs its own input listener at construction time and that
  // handler consumes every mouse event, so anything registered later via
  // tui.addInputListener() never sees one. Read the same bytes off stdin
  // directly instead — Node delivers every chunk to each "data" listener.
  const stream = process.stdin;
  if (!stream || typeof stream.on !== "function") return () => {};
  const onClick = (chunk: Buffer | string): void => {
    const alt = tui as TUI & {
      isFollowingOutput?: boolean;
      scrollToBottom?: () => void;
      previousScreen?: string[];
    };
    if (alt.isFollowingOutput !== false || typeof alt.scrollToBottom !== "function") return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    MOUSE_PRESS_RE.lastIndex = 0;
    // A chunk can carry more than one event; any of them may be the banner.
    for (let match = MOUSE_PRESS_RE.exec(text); match; match = MOUSE_PRESS_RE.exec(text)) {
      // SGR coordinates are 1-based; previousScreen is indexed by screen row.
      if (!isBannerHit(alt.previousScreen, Number(match[1]) - 1, Number(match[2]) - 1)) continue;
      alt.scrollToBottom();
      return;
    }
  };
  stream.on("data", onClick);
  return () => {
    stream.removeListener("data", onClick);
  };
}

function shortProvider(provider: string | undefined): string {
  if (!provider) return "";
  return PROVIDER_NAMES[provider] ?? provider;
}

function shortModel(model: string | undefined, provider?: string): string {
  const base = baseModelId(model);
  if (!base) return "no-model";
  // xai: grok-4.6 → 4.6 (provider chip already says "x")
  if (provider === "xai") {
    const version = /^grok-(.+)$/i.exec(base)?.[1];
    if (version) return version.toLowerCase();
  }
  for (const [pattern, replacement] of MODEL_RULES) {
    // Aliased ids render lowercase; unknown ids pass through with their original casing.
    if (pattern.test(base)) return base.replace(pattern, replacement).toLowerCase();
  }
  return base;
}

function shortThinking(level: string): string {
  return THINKING_NAMES[level] ?? level;
}

/**
 * 0 → "0", 12_300 → "12.3k", 123_400 → "123k", 1_000_000 → "1m".
 *
 * Caps at 3 significant digits: at 100k the tenths place becomes a 4th digit of
 * jittery noise, so it is dropped.
 */
function formatCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 100_000) return `${trimFixed(value / 1_000, 1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
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

/** The active profile's agent directory (`pia` runs a second one). */
function agentDir(): string {
  // Resolved per call, not at module load, so a HOME change is picked up.
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** `$HOME/x` → `~/x`, so a notification names a path the way settings do. */
function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Which pi-approval-guardian the active profile pinned, e.g.
 * "npm:pi-approval-guardian@0.8.0".
 *
 * Read from settings rather than from the loaded extension: /bypass fails when
 * the guardian is a build without the control event, and the only actionable
 * thing to say is which pin produced it and which file to change. Both profiles
 * here share one packages tree, so the installed files cannot tell them apart —
 * the settings file is what actually differs.
 */
async function guardianPin(): Promise<{ pin: string; settings: string }> {
  const settings = join(agentDir(), "settings.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(settings, "utf8"));
    const packages = (parsed as { packages?: unknown } | null)?.packages;
    if (Array.isArray(packages)) {
      const pin = packages.find(
        (entry): entry is string =>
          typeof entry === "string" && entry.includes("pi-approval-guardian"),
      );
      if (pin) return { pin, settings };
    }
  } catch {
    // No settings file, or a half-written one: fall back to the generic wording.
  }
  return { pin: "", settings };
}

function bootLogPath(): string {
  return join(agentDir(), BOOT_LOG_FILE);
}

/**
 * pi's package.json, resolved fresh on every call. Prefer argv[1] while its
 * entrypoint still exists; an update can remove the old bundle out from under
 * a running process, so fall back to the global package beside node itself.
 */
async function piPackageJsonPath(): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const entry = process.argv[1];
    if (entry) {
      const resolved = await realpath(entry);
      candidates.push(join(dirname(dirname(resolved)), "package.json"));
    }
  } catch {
    // The update may have removed the running process's old entrypoint.
  }
  candidates.push(
    join(
      dirname(dirname(process.execPath)),
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    ),
  );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next installation layout.
    }
  }
  return null;
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

  const dir = agentDir();
  // Redirect by path, not by inherited fd: Node opens files with O_CLOEXEC,
  // so fd numbers from this process don't exist in the detached child.
  const logPath = join(dir, AUTO_BUNDLE_LOG);
  const lockPath = join(dir, AUTO_BUNDLE_LOCK);
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
  // Read before appending: `since` needs the previous record's timestamp, and
  // the trim below can reuse the same read instead of a second stat + read.
  const existing = await readFile(file, "utf8").catch(() => "");
  const lines = existing.split("\n").filter(Boolean);
  const now = Date.now();
  const previous = lastBootTime(lines);
  const line = `${JSON.stringify({
    t: new Date(now).toISOString(),
    ms,
    v: await piVersion(),
    cwd,
    // Both are for reading the log later, not for anything at runtime: they are
    // what separates "this build got slower" from "this launch was unlucky".
    since: previous === undefined ? undefined : Math.round((now - previous) / 1_000),
    load: Math.round((loadavg()[0] ?? 0) * 100) / 100,
  })}\n`;
  await appendFile(file, line);
  // Concurrent pi processes can race this and drop a line or two. Fine: it is a
  // trend log, not an audit log.
  if (existing.length + line.length <= BOOT_LOG_MAX_BYTES) return;
  const kept = [...lines, line.trimEnd()].slice(-BOOT_LOG_KEEP);
  await writeFile(file, `${kept.join("\n")}\n`);
}

/** Epoch ms of the newest parseable record, or undefined for an empty log. */
function lastBootTime(lines: readonly string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const t = (JSON.parse(lines[index] as string) as { t?: unknown }).t;
      if (typeof t !== "string") continue;
      const parsed = Date.parse(t);
      if (Number.isFinite(parsed)) return parsed;
    } catch {
      // Half-written line from a racing process; keep walking back.
    }
  }
  return undefined;
}

interface BootRecord {
  ms: number;
  /** Seconds since the previous cold start; absent on records written before this was logged. */
  since?: number;
  /** 1-minute load average at first paint; absent on older records. */
  load?: number;
}

async function readBoots(limit: number): Promise<BootRecord[]> {
  const out: BootRecord[] = [];
  for (const line of (await readFile(bootLogPath(), "utf8")).split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { ms?: unknown; since?: unknown; load?: unknown };
      if (typeof entry.ms !== "number" || !Number.isFinite(entry.ms)) continue;
      out.push({
        ms: entry.ms,
        since: typeof entry.since === "number" && Number.isFinite(entry.since) ? entry.since : undefined,
        load: typeof entry.load === "number" && Number.isFinite(entry.load) ? entry.load : undefined,
      });
    } catch {
      // Half-written line from a racing process.
    }
  }
  return out.slice(-limit);
}

/** "p50 743ms · min 488ms · max 2.08s" over one cohort, or "" when it is empty. */
function cohortSummary(values: readonly number[]): string {
  if (values.length === 0) return "";
  const sorted = [...values].sort((a, b) => a - b);
  return (
    `p50 ${formatMs(percentile(sorted, 50))}` +
    ` · min ${formatMs(sorted[0] as number)}` +
    ` · max ${formatMs(sorted[sorted.length - 1] as number)}`
  );
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

/** Pace `!`s from the usage chips: 1 = >5pts ahead, 2 = >10, 3 = >20. `↻` is at-limit. */
function paceWarningColorCode(value: string): number {
  if (value.includes("\u21bb")) return RED;
  const bangs = /!+$/.exec(value)?.[0].length ?? 0;
  if (bangs >= 2) return RED;
  if (bangs === 1) return YELLOW;
  return CYAN;
}

/** A window label like "1.2/5H:" — each such token starts a fresh window group. */
const WINDOW_LABEL_RE = /^\d+(\.\d+)?\/\d+(\.\d+)?[HD]:$/;

/** Split a multi-window chip so each window colors independently:
 *  "1.2/5H: 43%!! 3.4/7D: 80%" → ["1.2/5H: 43%!!", "3.4/7D: 80%"].
 *  Single-window chips (copilot, grok) come back as one untouched group. */
function windowGroups(value: string): string[] {
  const groups: string[] = [];
  for (const token of value.split(" ")) {
    if (groups.length === 0 || WINDOW_LABEL_RE.test(token)) {
      groups.push(token);
    } else {
      groups[groups.length - 1] += ` ${token}`;
    }
  }
  return groups;
}

export default function footerExtension(pi: ExtensionAPI): void {
  const git = new GitStatusCache(pi);
  const peer = new PeerNameCache();
  const update = new UpdateCheckCache();
  const updateReady = update.init().catch(() => {});
  let enabled = true;
  let bypassed = false;
  let runtimeContext: ExtensionContext | undefined;
  let repaint: (() => void) | undefined;
  /** Live widget state while the scrollback banner is mounted. Its "unseen"
   * field is the single source of truth for the new-message count; renders
   * zero it when you return to the bottom. */
  let unseenState: ScrollbackState | undefined;
  /** Live TUI while the scrollback widget is mounted, for message_start checks. */
  let scrollTui: TUI | undefined;
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
      ctx.ui.setWidget(SCROLLBACK_WIDGET_KEY, undefined);
      ctx.ui.setWidget(UPDATE_WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(SCROLLBACK_WIDGET_KEY, (tui) => {
      // Click-to-jump shares the widget's lifecycle: dispose() detaches it.
      const removeListener = tui.mode === "fullscreen" ? attachScrollbackClick(tui) : () => {};
      scrollTui = tui;
      const scrollbackState: ScrollbackState = { unseen: 0 };
      unseenState = scrollbackState;
      return {
        ...scrollbackWidget(tui, scrollbackState),
        dispose: () => {
          removeListener();
          scrollTui = undefined;
          if (unseenState === scrollbackState) unseenState = undefined;
        },
      };
    });
    ctx.ui.setWidget(UPDATE_WIDGET_KEY, (tui) => ({
      invalidate(): void {},
      render(width: number): string[] {
        if (width <= 0) return [];
        const installed = update.read(() => tui.requestRender());
        if (!installed) return [];
        const message =
          `Update installed ${versionLabel(installed.from)} → ${versionLabel(installed.to)}` +
          " · Restart to update";
        return [alignRight(color(GREEN, message), width)];
      },
    }));

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

          const left: string[] = [
            color(BLUE, basename(ctx.cwd)),
            color(BRIGHT_YELLOW, shortProvider(provider)),
            color(
              BRIGHT_YELLOW,
              `${routePrefix(provider, ctx.model?.id)}${shortModel(ctx.model?.id, provider)}`,
            ),
            color(BRIGHT_YELLOW, ctx.model?.reasoning ? shortThinking(pi.getThinkingLevel()) : ""),
            formatGit(branch, gitState),
            // context-length / context-window share one segment (no spaces around "/")
            `${color(
              contextColorCode(usage?.tokens, usage?.contextWindow),
              usage?.tokens == null ? "?" : formatCount(usage.tokens),
            )}/${color(CYAN, usage?.contextWindow ? formatCount(usage.contextWindow) : "?")}`,
            usageChip(provider)
              ? color(GREEN, usageChip(provider) as string)
              : hideSessionCost(provider, ctx)
                ? ""
                : color(GREEN, formatCost(sessionCost(ctx.sessionManager.getBranch()))),
            ...INLINE_STATUS_KEYS.map((key) => {
              const value = statuses.get(key);
              // Per-window coloring: a red 5h shouldn't paint the week red too.
              return value
                ? windowGroups(value)
                    .map((group) => color(paceWarningColorCode(group), group))
                    .join(" ")
                : "";
            }),
            showBoot ? theme.fg("dim", `⚡${formatMs(bootMs as number)}`) : "",
            // Last before the flex gap, so it sits closest to the right edge.
            bypassed ? color(BRIGHT_RED, "bypass") : "",
          ];

          const leftLine = left.filter(Boolean).join(" ");
          // Fall back to the name other agents use to reach this session.
          const sessionName = pi.getSessionName();
          const peerName = sessionName ? "" : peer.read(requestRender);
          // A /color'd session names itself in that color, matching the editor
          // border. Only a name you chose: a peer name pi-claude-link derived
          // stays dim, because it says "nobody named this" and a bright color
          // would claim otherwise.
          const tint = sessionColorAnsi();
          const right =
            sessionName ? (tint ? paint(tint, sessionName) : color(CYAN, sessionName))
            : peerName ? theme.fg("dim", peerName)
            : "";
          const mainLine =
            sessionName || peerName ?
              padBetween(leftLine, right, width)
            : truncateToWidth(leftLine, width, "…");

          const lines = [mainLine];
          const extra: string[] = [];
          for (const [key, value] of statuses) {
            if (!value || (INLINE_STATUS_KEYS as readonly string[]).includes(key)) continue;
            extra.push(value);
          }
          if (extra.length > 0) {
            lines.push(truncateToWidth(theme.fg("dim", extra.join(" ")), width, "…"));
          }
          return lines;
        },
      };
    });
  }

  function padBetween(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…");
  }

  function alignRight(text: string, width: number): string {
    const fitted = truncateToWidth(text, width, "…");
    return `${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`;
  }

  /**
   * Take over the guardian's persistent below-editor warning.
   *
   * The guardian refuses to bypass outside the TUI so its warning stays
   * visible; the footer marker is just as persistent, so the property holds —
   * but only while the footer is on, hence the `enabled` guard.
   */
  function suppressGuardianWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!enabled || !ctx.hasUI || !bypassed) return;
    ctx.ui.setWidget(GUARDIAN_WIDGET_KEY, undefined);
  }

  // baseten-usage.ts / openrouter-usage.ts ping these after writing fresh MTD
  // values to their globalThis stashes; without it the chip waits for the next
  // render event.
  pi.events.on("baseten-usage:updated", () => {
    repaint?.();
  });
  pi.events.on("openrouter-usage:updated", () => {
    repaint?.();
  });

  // openrouter-route.ts sniffs the served provider out of the response stream.
  pi.events.on("openrouter-route:updated", () => {
    repaint?.();
  });

  pi.events.on(GUARDIAN_BYPASS_STATE_EVENT, (state: unknown) => {
    if (
      !state ||
      typeof state !== "object" ||
      typeof (state as { active?: unknown }).active !== "boolean"
    ) return;
    bypassed = (state as { active: boolean }).active;
    if (bypassed && runtimeContext) suppressGuardianWidget(runtimeContext);
    repaint?.();
  });

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

      const request = { active: next, handled: false };
      pi.events.emit(GUARDIAN_BYPASS_CONTROL_EVENT, request);
      if (!request.handled) {
        const { pin, settings } = await guardianPin();
        ctx.ui.notify(
          `${pin || "The installed Approval Guardian"} does not support immediate bypass control.` +
            ` Pin ${GUARDIAN_FORK_PACKAGE} in ${tildePath(settings)} and /reload,` +
            " or use /approval-guardian bypass.",
          "error",
        );
        return;
      }
      if (next) suppressGuardianWidget(ctx);
    },
  });

  pi.registerCommand("boot", {
    description: "Show this launch's boot time, or /boot stats [n] for recent launches",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (/^stats\b/.test(argument)) {
        const requested = Number.parseInt(argument.slice("stats".length).trim(), 10);
        const limit = Number.isFinite(requested) && requested > 0 ? requested : BOOT_STATS_DEFAULT;
        let boots: BootRecord[] = [];
        try {
          boots = await readBoots(limit);
        } catch {
          // No log yet.
        }
        if (boots.length === 0) {
          ctx.ui.notify("No boot times recorded yet", "warning");
          return;
        }
        const sorted = boots.map((boot) => boot.ms).sort((a, b) => a - b);
        // Compare like with like: a burst of relaunches and a one-off launch
        // differ by more than most changes worth measuring, so an undivided p50
        // mostly reports how you happened to be using pi that day.
        const burst = boots.filter((boot) => boot.since !== undefined && boot.since < BOOT_BURST_WINDOW_S);
        const isolated = boots.filter((boot) => boot.since !== undefined && boot.since >= BOOT_BURST_WINDOW_S);
        const loads = boots.map((boot) => boot.load).filter((load): load is number => load !== undefined);
        const cohorts = [
          burst.length > 0 ? `burst <${BOOT_BURST_WINDOW_S}s (n=${burst.length}) ${cohortSummary(burst.map((b) => b.ms))}` : "",
          isolated.length > 0 ? `isolated (n=${isolated.length}) ${cohortSummary(isolated.map((b) => b.ms))}` : "",
          loads.length > 0 ? `load p50 ${percentile([...loads].sort((a, b) => a - b), 50).toFixed(2)}` : "",
        ].filter(Boolean);
        ctx.ui.notify(
          `${boots.length} launches · p50 ${formatMs(percentile(sorted, 50))}` +
            ` · p95 ${formatMs(percentile(sorted, 95))}` +
            ` · min ${formatMs(sorted[0] ?? 0)} · max ${formatMs(sorted[sorted.length - 1] ?? 0)}` +
            (bootMs === undefined ? "" : ` · this one ${formatMs(bootMs)}`) +
            (cohorts.length > 0 ? `\n${cohorts.join(" · ")}` : ""),
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

  // Count assistant content that arrives while the user is scrolled up, so
  // the banner can say "2 new messages" instead of just "scrolled".
  //
  // message_start alone isn't enough: it only fires when a message BEGINS, so
  // scrolling up mid-response would never count the rest of that response.
  // message_update chunks are shallow clones ({...partialMessage}), so instead
  // of deduping by identity we count each streamed message at most once via
  // this flag, reset on every assistant message_start.
  let streamCounted = false;
  const bumpUnseen = (): void => {
    if (!unseenState) return;
    unseenState.unseen += 1;
    repaint?.();
  };
  const isScrolledUp = (): boolean => {
    if (!scrollTui) return false;
    const alt = scrollTui as TUI & { isFollowingOutput?: boolean };
    return alt.isFollowingOutput === false;
  };
  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return undefined;
    streamCounted = false;
    // A message beginning while already scrolled up counts here; marking it
    // counted stops its streaming chunks from counting it a second time.
    if (isScrolledUp()) {
      bumpUnseen();
      streamCounted = true;
    }
    return undefined;
  });
  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant" || streamCounted || !isScrolledUp()) return undefined;
    // Counts a message that began before the user scrolled up exactly once:
    // its first chunk after scrolling marks it counted.
    streamCounted = true;
    bumpUnseen();
    return undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    await updateReady;
    runtimeContext = ctx;
    // The guardian's bypass resets when the session runtime reloads.
    bypassed = false;
    if (unseenState) unseenState.unseen = 0;
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
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget(SCROLLBACK_WIDGET_KEY, undefined);
      ctx.ui.setWidget(UPDATE_WIDGET_KEY, undefined);
    }
  });
}
