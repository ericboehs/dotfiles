/**
 * All usage/quota chips in one extension: codex, copilot, grok (status-line
 * windows) and baseten, openrouter (cost-slot MTD replacements).
 *
 * Each provider is a Driver: a provider gate, a fetch, and a display mode.
 * The display mode decides where the value lands:
 *   - statusKey  → ctx.ui.setStatus, painted by footer's INLINE_STATUS_KEYS
 *                  with per-window pace coloring
 *   - stashKey   → globalThis stash read by footer for the cost slot, plus an
 *                  update event so the footer repaints immediately
 *
 * Consolidated from five near-identical extensions. The scaffolding (generation
 * guard, stale-value paint, warn-once failure logging, lifecycle handlers,
 * command registration) lives here once; only gates and fetches differ.
 *
 * Fire-and-forget refresh: pi awaits session_start/model_select handlers, so
 * awaiting the usage round-trip there blocks TUI startup and the model picker.
 * Per-driver generation guards discard stale responses instead.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUEST_TIMEOUT_MS = 10_000;
const SLOW_BILLING_TIMEOUT_MS = 30_000;
// Providers that update billing data hourly; no point polling faster.
const HOURLY_CACHE_TTL_MS = 5 * 60 * 1000;
const STASH_KEY_BASETEN = "__piBasetenUsage";
const STASH_KEY_OPENROUTER = "__piOpenRouterUsage";
const EVENT_BASETEN = "baseten-usage:updated";
const EVENT_OPENROUTER = "openrouter-usage:updated";
const BUDGET_ENV_BASETEN = "BASETEN_MONTHLY_BUDGET";
const BUDGET_ENV_OPENROUTER = "OPENROUTER_MONTHLY_BUDGET";

interface UsageDisplay {
  value: string;
  /** Multi-line body for the /command notification; defaults to `value`. */
  commandText?: string;
}

interface Driver {
  /** Log prefix, e.g. "[codex-window] usage fetch failed". */
  id: string;
  provider: string;
  statusKey?: string;
  stashKey?: string;
  updateEvent?: string;
  /** Undefined = refetch on every settle (the window chips' old behavior). */
  cacheTtlMs?: number;
  /** Per-request timeout; defaults to 10s. Baseten's billing API has slow
   *  stretches (observed 9s responses), so it gets a looser leash. */
  timeoutMs?: number;
  command: { name: string; description: string; scopeNote: string };
  isActive(ctx: ExtensionContext): boolean;
  fetch(ctx: ExtensionContext): Promise<UsageDisplay>;
}

interface DriverState {
  generation: number;
  last: UsageDisplay | undefined;
  lastFetchMs: number;
  warned: boolean;
}

const states = new Map<string, DriverState>();

function stateFor(driver: Driver): DriverState {
  let state = states.get(driver.id);
  if (!state) {
    state = { generation: 0, last: undefined, lastFetchMs: 0, warned: false };
    states.set(driver.id, state);
  }
  return state;
}

// ---------- shared helpers ----------

function isProvider(ctx: ExtensionContext, provider: string): boolean {
  return ctx.model?.provider === provider;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`usage request failed (${response.status})`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function providerApiKey(
  ctx: ExtensionContext,
  provider: string,
): Promise<string | undefined> {
  try {
    const resolved = await ctx.modelRegistry.getProviderAuth(provider);
    const key = resolved?.auth?.apiKey;
    if (typeof key === "string" && key) return key;
  } catch {
    // No stored auth; caller falls back.
  }
  return undefined;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatDollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Compact local reset time: 3:45p, Sat 3:45p, Apr 1 3:45p. */
function formatResetClock(resetMs: number, nowMs = Date.now()): string {
  const reset = new Date(resetMs);
  const now = new Date(nowMs);
  const hours24 = reset.getHours();
  const minutes = String(reset.getMinutes()).padStart(2, "0");
  const time = `${hours24 % 12 || 12}:${minutes}${hours24 >= 12 ? "p" : "a"}`;

  if (
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate()
  ) {
    return time;
  }

  const startOfReset = new Date(reset.getFullYear(), reset.getMonth(), reset.getDate()).getTime();
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysAway = Math.round((startOfReset - startOfNow) / 86_400_000);
  if (daysAway > 0 && daysAway < 7) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(reset);
    return `${weekday} ${time}`;
  }

  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(reset);
  return `${date} ${time}`;
}

function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

// ---------- codex ----------

const USAGE_URL_CODEX = "https://chatgpt.com/backend-api/wham/usage";

interface UsageWindow {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
  window_minutes?: number;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  };
}

function accountIdFromJwt(token: string): string | undefined {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return undefined;

    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return undefined;

    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function windowSeconds(window: UsageWindow): number | undefined {
  if (
    typeof window.limit_window_seconds === "number" &&
    Number.isFinite(window.limit_window_seconds) &&
    window.limit_window_seconds > 0
  ) {
    return window.limit_window_seconds;
  }

  if (
    typeof window.window_minutes === "number" &&
    Number.isFinite(window.window_minutes) &&
    window.window_minutes > 0
  ) {
    return window.window_minutes * 60;
  }

  return undefined;
}

function resetAtMs(window: UsageWindow, nowMs = Date.now()): number | undefined {
  if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
    return window.reset_at > 10_000_000_000
      ? window.reset_at
      : window.reset_at * 1000;
  }

  if (
    typeof window.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds)
  ) {
    return nowMs + window.reset_after_seconds * 1000;
  }

  return undefined;
}

function windowLabel(window: UsageWindow): string | undefined {
  const totalSeconds = windowSeconds(window);
  if (totalSeconds === undefined) return undefined;

  return totalSeconds >= 86_400
    ? `${formatNumber(totalSeconds / 86_400)}D`
    : `${formatNumber(totalSeconds / 3_600)}H`;
}

function formatReset(window: UsageWindow, nowMs = Date.now()): string | undefined {
  const label = windowLabel(window);
  const reset = resetAtMs(window, nowMs);
  if (!label || reset === undefined) return undefined;

  const formatted = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(reset));
  return `${label} ${formatted}`;
}

function formatCodexWindow(window: UsageWindow, nowMs = Date.now()): string | undefined {
  const totalSeconds = windowSeconds(window);
  const usedPercent = window.used_percent;
  if (totalSeconds === undefined || typeof usedPercent !== "number") return undefined;

  const reset = resetAtMs(window, nowMs);
  if (reset === undefined) return undefined;
  const remainingSeconds = (reset - nowMs) / 1000;

  const elapsedSeconds = Math.max(
    0,
    Math.min(totalSeconds, totalSeconds - remainingSeconds),
  );
  const percent = Math.max(0, Math.min(100, usedPercent));
  const expectedPercent = (elapsedSeconds / totalSeconds) * 100;
  const pointsAhead = percent - expectedPercent;
  const warningCount = pointsAhead > 20 ? 3 : pointsAhead > 10 ? 2 : pointsAhead > 5 ? 1 : 0;
  const warning = "!".repeat(warningCount);
  // 100% is not actionable; the reset is. Footer colors ↻ red.
  const usage =
    formatNumber(percent) === "100"
      ? `↻${formatResetClock(reset, nowMs)}`
      : `${formatNumber(percent)}%${warning}`;

  if (totalSeconds >= 86_400) {
    const elapsedDays = elapsedSeconds / 86_400;
    const totalDays = totalSeconds / 86_400;
    return `${formatNumber(elapsedDays)}/${formatNumber(totalDays)}D: ${usage}`;
  }

  const elapsedHours = elapsedSeconds / 3_600;
  const totalHours = totalSeconds / 3_600;
  return `${formatNumber(elapsedHours)}/${formatNumber(totalHours)}H: ${usage}`;
}

async function fetchCodex(ctx: ExtensionContext): Promise<UsageDisplay> {
  const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const accessToken = resolved?.auth.apiKey;
  if (!accessToken) throw new Error("OpenAI Codex authentication is unavailable");

  const accountId = accountIdFromJwt(accessToken);
  const usage = (await fetchJson(USAGE_URL_CODEX, {
    authorization: `Bearer ${accessToken}`,
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    "user-agent": "pi-codex-window/1.0",
  })) as CodexUsageResponse;

  const windows = [
    usage.rate_limit?.primary_window,
    usage.rate_limit?.secondary_window,
  ]
    .filter((window): window is UsageWindow => {
      return (
        window != null &&
        typeof window.used_percent === "number" &&
        windowSeconds(window) !== undefined
      );
    })
    // Shortest first: the ~5h cap gates sooner than the 7-day quota.
    .sort(
      (left, right) => (windowSeconds(left) ?? 0) - (windowSeconds(right) ?? 0),
    );

  const nowMs = Date.now();
  const value = windows
    .map((window) => formatCodexWindow(window, nowMs))
    .filter((formatted): formatted is string => formatted !== undefined)
    .join(" ");
  if (!value) throw new Error("no timed usage window was returned");

  const resetSummary = windows
    .map((window) => formatReset(window, nowMs))
    .filter((formatted): formatted is string => formatted !== undefined)
    .join(" ");
  return { value, commandText: `${value}\nResets: ${resetSummary}` };
}

// ---------- copilot ----------

interface QuotaSnapshot {
  entitlement?: number;
  remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  reset_date?: string;
}

interface CopilotUser {
  quota_reset_date?: string;
  quota_snapshots?: {
    premium_interactions?: QuotaSnapshot;
  };
}

interface StoredCopilotCredential {
  type?: "oauth" | "api_key";
  refresh?: string;
  enterpriseUrl?: string;
}

async function readStoredCopilotCredential(): Promise<StoredCopilotCredential | undefined> {
  try {
    const raw = await readFile(join(agentDirectory(), "auth.json"), "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const credential = auth["github-copilot"];
    return credential && typeof credential === "object"
      ? (credential as StoredCopilotCredential)
      : undefined;
  } catch (err) {
    // A missing auth.json just means Copilot isn't configured. Anything else
    // (corrupt JSON, bad permissions) should surface through fetch's error path
    // instead of masquerading as "not configured".
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return undefined;
  }
}

function normalizeHostname(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function copilotUsageEndpoint(enterpriseUrl?: string, copilotBaseUrl?: string): string {
  const enterpriseHost = normalizeHostname(enterpriseUrl);
  if (enterpriseHost && enterpriseHost !== "github.com") {
    return `https://api.${enterpriseHost}/copilot_internal/user`;
  }

  const copilotHost = normalizeHostname(copilotBaseUrl);
  if (copilotHost?.startsWith("copilot-api.")) {
    return `https://api.${copilotHost.slice("copilot-api.".length)}/copilot_internal/user`;
  }

  // Individual, business, and enterprise-cloud Copilot proxy hosts all use
  // api.github.com for the user quota endpoint.
  return "https://api.github.com/copilot_internal/user";
}

function previousMonthlyReset(reset: Date): Date {
  const year = reset.getUTCFullYear();
  const month = reset.getUTCMonth();
  const day = reset.getUTCDate();
  const lastDayOfPreviousMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month - 1,
      Math.min(day, lastDayOfPreviousMonth),
      reset.getUTCHours(),
      reset.getUTCMinutes(),
      reset.getUTCSeconds(),
    ),
  );
}

function parseResetDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function copilotUsedPercent(quota: QuotaSnapshot): number | undefined {
  if (
    typeof quota.percent_remaining === "number" &&
    Number.isFinite(quota.percent_remaining)
  ) {
    return Math.max(0, Math.min(100, 100 - quota.percent_remaining));
  }

  if (
    typeof quota.entitlement === "number" &&
    quota.entitlement > 0 &&
    typeof quota.remaining === "number"
  ) {
    return Math.max(
      0,
      Math.min(100, ((quota.entitlement - quota.remaining) / quota.entitlement) * 100),
    );
  }

  return undefined;
}

function formatCopilotQuota(
  quota: QuotaSnapshot,
  resetDateValue?: string,
  nowMs = Date.now(),
): string | undefined {
  if (quota.unlimited) return "unlimited";

  const percent = copilotUsedPercent(quota);
  const reset = parseResetDate(quota.reset_date ?? resetDateValue);
  if (percent === undefined || !reset) return undefined;

  const start = previousMonthlyReset(reset);
  const totalMs = reset.getTime() - start.getTime();
  if (totalMs <= 0) return undefined;

  const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - start.getTime()));
  const expectedPercent = (elapsedMs / totalMs) * 100;
  const pointsAhead = percent - expectedPercent;
  const warningCount = pointsAhead > 20 ? 3 : pointsAhead > 10 ? 2 : pointsAhead > 5 ? 1 : 0;
  const warning = "!".repeat(warningCount);
  // 100% is not actionable; the reset is. Footer colors ↻ red.
  if (formatNumber(percent) === "100") {
    return `↻${formatResetClock(reset.getTime(), nowMs)}`;
  }

  return `${formatNumber(percent)}%${warning}`;
}

async function fetchCopilot(ctx: ExtensionContext): Promise<UsageDisplay> {
  const [resolved, stored] = await Promise.all([
    ctx.modelRegistry.getProviderAuth("github-copilot"),
    readStoredCopilotCredential(),
  ]);

  // Standard Pi Copilot OAuth stores the long-lived GitHub token as `refresh`.
  // Command-backed or direct API-key setups use Pi's securely resolved key.
  const token =
    stored?.type === "oauth" && stored.refresh
      ? stored.refresh
      : resolved?.auth.apiKey;
  if (!token) throw new Error("GitHub Copilot authentication is unavailable");

  const providerBaseUrl =
    resolved?.auth.baseUrl ?? ctx.modelRegistry.getProvider("github-copilot")?.baseUrl;
  const endpoint = copilotUsageEndpoint(stored?.enterpriseUrl, providerBaseUrl);
  const usage = (await fetchJson(endpoint, {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "pi-copilot-window/1.0",
    "copilot-integration-id": "copilot-developer-cli",
  })) as CopilotUser;

  const quota = usage.quota_snapshots?.premium_interactions;
  if (!quota) throw new Error("premium interaction quota was not returned");

  const value = formatCopilotQuota(quota, usage.quota_reset_date);
  if (!value) throw new Error("quota window could not be calculated");
  return { value };
}

// ---------- grok ----------

const CREDITS_URL_GROK = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MONTHLY_URL_GROK = "https://cli-chat-proxy.grok.com/v1/billing";

interface GrokUsageWindow {
  used_percent: number;
  reset_at: number;
  limit_window_seconds: number;
}

interface WeeklyParse {
  window: GrokUsageWindow;
  inferred: boolean;
  unified: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function money(value: unknown): number | undefined {
  const direct = asNumber(value);
  if (direct !== undefined) return direct;
  return asNumber(asRecord(value)?.val);
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWeekly(payload: unknown): WeeklyParse | undefined {
  const config = asRecord(asRecord(payload)?.config);
  if (!config) return undefined;

  const period = asRecord(config.currentPeriod);
  if (!period) return undefined;

  const type = typeof period.type === "string" ? period.type : "";
  if (type && !type.toUpperCase().includes("WEEK")) return undefined;

  const startMs = parseIsoMs(period.start);
  const endMs = parseIsoMs(period.end);
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;

  const inferred = config.creditUsagePercent == null;
  const usedPercent = inferred
    ? endMs > Date.now() ? 0 : undefined
    : asNumber(config.creditUsagePercent);
  if (usedPercent === undefined) return undefined;

  return {
    inferred,
    unified: config.isUnifiedBillingUser === true,
    window: {
      used_percent: usedPercent,
      reset_at: endMs / 1000,
      limit_window_seconds: (endMs - startMs) / 1000,
    },
  };
}

function parseMonthly(payload: unknown): GrokUsageWindow | undefined {
  const config = asRecord(asRecord(payload)?.config);
  if (!config) return undefined;

  const startMs = parseIsoMs(config.billingPeriodStart);
  const endMs = parseIsoMs(config.billingPeriodEnd);
  const limit = money(config.monthlyLimit);
  const used = money(config.used);
  if (
    startMs === undefined ||
    endMs === undefined ||
    endMs <= startMs ||
    limit === undefined ||
    limit <= 0 ||
    used === undefined
  ) {
    return undefined;
  }

  return {
    used_percent: Math.max(0, Math.min(100, (used / limit) * 100)),
    reset_at: endMs / 1000,
    limit_window_seconds: (endMs - startMs) / 1000,
  };
}

function formatGrokWindow(window: GrokUsageWindow, nowMs = Date.now()): string | undefined {
  const totalSeconds = window.limit_window_seconds;
  if (!(totalSeconds > 0)) return undefined;

  const remainingSeconds = window.reset_at - nowMs / 1000;
  const elapsedSeconds = Math.max(0, Math.min(totalSeconds, totalSeconds - remainingSeconds));
  const percent = Math.max(0, Math.min(100, window.used_percent));
  const expectedPercent = (elapsedSeconds / totalSeconds) * 100;
  const pointsAhead = percent - expectedPercent;
  const warningCount = pointsAhead > 20 ? 3 : pointsAhead > 10 ? 2 : pointsAhead > 5 ? 1 : 0;
  const warning = "!".repeat(warningCount);
  // 100% is not actionable; the reset is. Footer colors ↻ red.
  const usage =
    formatNumber(percent) === "100"
      ? `↻${formatResetClock(window.reset_at * 1000, nowMs)}`
      : `${formatNumber(percent)}%${warning}`;

  if (totalSeconds >= 86_400) {
    const elapsedDays = elapsedSeconds / 86_400;
    const totalDays = totalSeconds / 86_400;
    return `${formatNumber(elapsedDays)}/${formatNumber(totalDays)}D: ${usage}`;
  }

  const elapsedHours = elapsedSeconds / 3_600;
  const totalHours = totalSeconds / 3_600;
  return `${formatNumber(elapsedHours)}/${formatNumber(totalHours)}H: ${usage}`;
}

async function fetchGrok(ctx: ExtensionContext): Promise<UsageDisplay> {
  const resolved = await ctx.modelRegistry.getProviderAuth("xai");
  const accessToken = resolved?.auth.apiKey;
  if (!accessToken) throw new Error("xAI subscription authentication is unavailable");
  // Paid API keys are a different product and must never hit this endpoint.
  if (accessToken.startsWith("xai-")) {
    throw new Error("xAI API keys are not SuperGrok");
  }

  const grokHeaders = {
    authorization: `Bearer ${accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
    "user-agent": "pi-grok-window/1.0",
  };

  const credits = await fetchJson(CREDITS_URL_GROK, grokHeaders);
  const weekly = parseWeekly(credits);
  const shouldProbeMonthly = !weekly || (weekly.inferred && weekly.unified);

  let monthly: GrokUsageWindow | undefined;
  if (shouldProbeMonthly) {
    try {
      monthly = parseMonthly(await fetchJson(MONTHLY_URL_GROK, grokHeaders));
    } catch (err) {
      // A real weekly percent can still stand alone if the monthly probe fails.
      if (!weekly || weekly.inferred) throw err;
    }
  }

  const window = weekly && !(weekly.inferred && monthly) ? weekly.window : monthly;
  const value = window ? formatGrokWindow(window) : undefined;
  if (!value) throw new Error("no SuperGrok usage window was returned");
  return { value };
}

// ---------- baseten ----------

const USAGE_URL_BASETEN = "https://api.baseten.co/v1/billing/usage_summary";

interface UsageSection {
  subtotal?: number | string;
  credits_used?: number | string;
  total?: number | string;
}

interface BasetenUsageResponse {
  dedicated_usage?: UsageSection | null;
  training_usage?: UsageSection | null;
  model_apis_usage?: UsageSection & {
    breakdown?: Array<{
      model_name?: string;
      subtotal?: number | string;
      input_tokens?: number | string;
      output_tokens?: number | string;
    }>;
  };
}

/** Start of the current calendar month in UTC (Baseten budgets are monthly). */
function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function isoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function positiveEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function budgetPart(total: number, envVar: string): string {
  const budgetAmount = positiveEnvNumber(envVar);
  return budgetAmount
    ? ` / ${formatDollars(budgetAmount)} (${Math.round((total / budgetAmount) * 100)}%)`
    : "";
}

async function fetchBaseten(ctx: ExtensionContext): Promise<UsageDisplay> {
  const apiKey = process.env.BASETEN_API_KEY;
  if (!apiKey) throw new Error("BASETEN_API_KEY is not set");

  const now = new Date();
  const url =
    `${USAGE_URL_BASETEN}` +
    `?start_date=${encodeURIComponent(isoUtc(monthStartUtc(now)))}` +
    `&end_date=${encodeURIComponent(isoUtc(now))}`;

  const usage = (await fetchJson(
    url,
    {
      authorization: `Bearer ${apiKey}`,
      "user-agent": "pi-baseten-usage/1.0",
    },
    SLOW_BILLING_TIMEOUT_MS,
  )) as BasetenUsageResponse;

  const sections: Array<[string, UsageSection | null | undefined]> = [
    ["Dedicated", usage.dedicated_usage],
    ["Model APIs", usage.model_apis_usage],
    ["Training", usage.training_usage],
  ];

  let grandTotal = 0;
  let grandCredits = 0;
  const lines: string[] = [];
  for (const [label, section] of sections) {
    if (!section) continue;
    const subtotal = toNumber(section.subtotal);
    const credits = toNumber(section.credits_used);
    const total = toNumber(section.total);
    if (subtotal === 0 && credits === 0 && total === 0) continue;
    grandTotal += total;
    grandCredits += credits;
    lines.push(`${label}: ${formatDollars(total)} (credits -${formatDollars(credits)})`);
  }

  const value = `${formatDollars(grandTotal)}${budgetPart(grandTotal, BUDGET_ENV_BASETEN)}`;

  const detail = [`MTD total: ${formatDollars(grandTotal)} (net of ${formatDollars(grandCredits)} credits)`];
  detail.push(...(lines.length > 0 ? lines : ["No usage this month."]));

  const breakdown = usage.model_apis_usage?.breakdown;
  if (breakdown && breakdown.length > 0) {
    const top = [...breakdown]
      .sort((left, right) => toNumber(right.subtotal) - toNumber(left.subtotal))
      .slice(0, 5);
    detail.push("Top models:");
    for (const entry of top) {
      detail.push(`  ${entry.model_name ?? "unknown"}: ${formatDollars(toNumber(entry.subtotal))}`);
    }
  }

  return { value, commandText: detail.join("\n") };
}

// ---------- openrouter ----------

const KEY_URL_OPENROUTER = "https://openrouter.ai/api/v1/key";

/**
 * GET /api/v1/key describes the API key the request authenticated with.
 * `usage_monthly` is spend over the current UTC month — the same MTD window
 * the Baseten chip uses. BYOK usage is billed separately (5%) and reported
 * alongside.
 */
interface OpenRouterKeyData {
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  byok_usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
}

interface OpenRouterKeyResponse {
  data?: OpenRouterKeyData;
}

async function fetchOpenRouter(ctx: ExtensionContext): Promise<UsageDisplay> {
  const apiKey =
    (await providerApiKey(ctx, "openrouter")) ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("no OpenRouter credential (pi auth or OPENROUTER_API_KEY)");
  }

  const { data } = (await fetchJson(KEY_URL_OPENROUTER, {
    authorization: `Bearer ${apiKey}`,
    "user-agent": "pi-openrouter-usage/1.0",
  })) as OpenRouterKeyResponse;
  if (!data) throw new Error("key response had no data");

  const mtd = toNumber(data.usage_monthly);
  const byokMtd = toNumber(data.byok_usage_monthly);

  const value = `${formatDollars(mtd)}${budgetPart(mtd, BUDGET_ENV_OPENROUTER)}`;

  const detail = [`MTD (UTC month): ${formatDollars(mtd)}`];
  if (byokMtd > 0) detail.push(`BYOK MTD: ${formatDollars(byokMtd)}`);
  detail.push(`Today: ${formatDollars(toNumber(data.usage_daily))}`);
  detail.push(`All-time on this key: ${formatDollars(toNumber(data.usage))}`);
  if (data.limit != null) {
    detail.push(
      `Key limit: ${formatDollars(toNumber(data.limit_remaining))} left of ${formatDollars(toNumber(data.limit))}`,
    );
  }

  return { value, commandText: detail.join("\n") };
}

// ---------- drivers ----------

const DRIVERS: Driver[] = [
  {
    id: "codex-window",
    provider: "openai-codex",
    statusKey: "codex-window",
    command: {
      name: "codex-window",
      description: "Refresh the compact Codex usage window",
      scopeNote: "Codex usage is only shown for openai-codex models",
    },
    isActive: (ctx) => isProvider(ctx, "openai-codex"),
    fetch: fetchCodex,
  },
  {
    id: "copilot-window",
    provider: "github-copilot",
    statusKey: "copilot-window",
    command: {
      name: "copilot-window",
      description: "Refresh the compact GitHub Copilot premium quota window",
      scopeNote: "Copilot usage is only shown for github-copilot models",
    },
    isActive: (ctx) => isProvider(ctx, "github-copilot"),
    fetch: fetchCopilot,
  },
  {
    id: "grok-window",
    provider: "xai",
    statusKey: "grok-window",
    command: {
      name: "grok-window",
      description: "Refresh the compact SuperGrok usage window",
      scopeNote: "SuperGrok usage is only shown for xAI subscription models",
    },
    // SuperGrok OAuth only: paid API keys are a different product.
    isActive: (ctx) =>
      ctx.model?.provider === "xai" && ctx.modelRegistry.isUsingOAuth(ctx.model),
    fetch: fetchGrok,
  },
  {
    id: "baseten-usage",
    provider: "baseten",
    stashKey: STASH_KEY_BASETEN,
    updateEvent: EVENT_BASETEN,
    cacheTtlMs: HOURLY_CACHE_TTL_MS,
    timeoutMs: SLOW_BILLING_TIMEOUT_MS,
    command: {
      name: "baseten-usage",
      description: "Show Baseten month-to-date billing usage",
      scopeNote: "Baseten usage is only shown for baseten models",
    },
    isActive: (ctx) => isProvider(ctx, "baseten"),
    fetch: fetchBaseten,
  },
  {
    id: "openrouter-usage",
    provider: "openrouter",
    stashKey: STASH_KEY_OPENROUTER,
    updateEvent: EVENT_OPENROUTER,
    cacheTtlMs: HOURLY_CACHE_TTL_MS,
    command: {
      name: "openrouter-usage",
      description: "Show OpenRouter month-to-date key usage",
      scopeNote: "OpenRouter usage is only shown for openrouter models",
    },
    isActive: (ctx) => isProvider(ctx, "openrouter"),
    fetch: fetchOpenRouter,
  },
];

function writeStash(driver: Driver, display: UsageDisplay): void {
  (globalThis as Record<string, unknown>)[driver.stashKey as string] = {
    value: display.value,
    fetchedAt: Date.now(),
  };
}

async function refreshDriver(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  driver: Driver,
  options: { force?: boolean } = {},
): Promise<UsageDisplay | undefined> {
  const state = stateFor(driver);
  const generation = ++state.generation;

  if (!driver.isActive(ctx)) {
    if (driver.statusKey) ctx.ui.setStatus(driver.statusKey, undefined);
    return undefined;
  }

  const ttl = driver.cacheTtlMs ?? 0;
  const cached = state.last && ttl > 0 && Date.now() - state.lastFetchMs < ttl;
  if (cached && !options.force) return state.last;

  // Paint the stale value so a slow round trip doesn't blank the chip.
  if (driver.statusKey && state.last) {
    ctx.ui.setStatus(driver.statusKey, state.last.value);
  }

  try {
    const display = await driver.fetch(ctx);
    if (generation !== state.generation || !driver.isActive(ctx)) return undefined;
    state.last = display;
    state.lastFetchMs = Date.now();
    if (driver.stashKey) writeStash(driver, display);
    if (driver.statusKey) ctx.ui.setStatus(driver.statusKey, display.value);
    if (state.warned) {
      state.warned = false;
      console.error(`[${driver.id}] usage fetch recovered`);
    }
    // The footer reads stashes during renders; poke it so a new cost-slot chip
    // paints immediately instead of waiting for the next render event.
    if (driver.updateEvent) pi.events.emit(driver.updateEvent, undefined);
    return display;
  } catch (err) {
    if (driver.statusKey && !state.last) {
      ctx.ui.setStatus(driver.statusKey, undefined);
    }
    // Log only the first failure of a streak (and the recovery) so a dead
    // token doesn't spam the console on every settle.
    if (!state.warned) {
      state.warned = true;
      console.error(
        `[${driver.id}] usage fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }
}

export default function providerUsage(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    for (const driver of DRIVERS) void refreshDriver(pi, ctx, driver);
  });

  pi.on("model_select", (_event, ctx) => {
    for (const driver of DRIVERS) void refreshDriver(pi, ctx, driver);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Fire-and-forget, unlike the original extensions: a slow billing API
    // (Baseten has 9s stretches) must never hold the settle open. Stale chips
    // keep painting, and stash writes ping the footer via update events.
    for (const driver of DRIVERS) void refreshDriver(pi, ctx, driver);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const driver of DRIVERS) {
      const state = stateFor(driver);
      state.generation += 1;
      if (driver.statusKey && ctx.hasUI) {
        ctx.ui.setStatus(driver.statusKey, undefined);
      }
    }
  });

  for (const driver of DRIVERS) {
    pi.registerCommand(driver.command.name, {
      description: driver.command.description,
      handler: async (_args, ctx) => {
        if (!driver.isActive(ctx)) {
          ctx.ui.notify(driver.command.scopeNote, "info");
          return;
        }

        const display = await refreshDriver(pi, ctx, driver, { force: true });
        const text = display ? (display.commandText ?? display.value) : null;
        ctx.ui.notify(text ?? "Usage is unavailable", text ? "info" : "error");
      },
    });
  }
}
