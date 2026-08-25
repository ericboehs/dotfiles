import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "github-copilot";
const STATUS_KEY = "copilot-window";
const REQUEST_TIMEOUT_MS = 10_000;

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

let requestGeneration = 0;
let lastValue: string | undefined;
// Log only the first failure of a streak (and the recovery) so a dead token
// doesn't spam the console on every settle.
let warned = false;

function isCopilot(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === PROVIDER;
}

function setStatus(ctx: ExtensionContext, value?: string): void {
  ctx.ui.setStatus(STATUS_KEY, value);
}

function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function readStoredCredential(): Promise<StoredCopilotCredential | undefined> {
  try {
    const raw = await readFile(join(agentDirectory(), "auth.json"), "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const credential = auth[PROVIDER];
    return credential && typeof credential === "object"
      ? (credential as StoredCopilotCredential)
      : undefined;
  } catch (err) {
    // A missing auth.json just means Copilot isn't configured. Anything else
    // (corrupt JSON, bad permissions) should surface through fetchValue's
    // error path instead of masquerading as "not configured".
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

function usageEndpoint(enterpriseUrl?: string, copilotBaseUrl?: string): string {
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

function usedPercent(quota: QuotaSnapshot): number | undefined {
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

function formatQuota(
  quota: QuotaSnapshot,
  resetDateValue?: string,
  nowMs = Date.now(),
): string | undefined {
  if (quota.unlimited) return "unlimited";

  const percent = usedPercent(quota);
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

async function fetchValue(ctx: ExtensionContext): Promise<string> {
  const [resolved, stored] = await Promise.all([
    ctx.modelRegistry.getProviderAuth(PROVIDER),
    readStoredCredential(),
  ]);

  // Standard Pi Copilot OAuth stores the long-lived GitHub token as `refresh`.
  // Command-backed or direct API-key setups use Pi's securely resolved key.
  const token =
    stored?.type === "oauth" && stored.refresh
      ? stored.refresh
      : resolved?.auth.apiKey;
  if (!token) throw new Error("GitHub Copilot authentication is unavailable");

  const providerBaseUrl =
    resolved?.auth.baseUrl ?? ctx.modelRegistry.getProvider(PROVIDER)?.baseUrl;
  const endpoint = usageEndpoint(stored?.enterpriseUrl, providerBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "pi-copilot-window/1.0",
        "copilot-integration-id": "copilot-developer-cli",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`usage request failed (${response.status})`);
    }

    const usage = (await response.json()) as CopilotUser;
    const quota = usage.quota_snapshots?.premium_interactions;
    if (!quota) throw new Error("premium interaction quota was not returned");

    const value = formatQuota(quota, usage.quota_reset_date);
    if (!value) throw new Error("quota window could not be calculated");
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function refresh(ctx: ExtensionContext): Promise<string | undefined> {
  const generation = ++requestGeneration;

  if (!isCopilot(ctx)) {
    setStatus(ctx, undefined);
    return undefined;
  }

  if (lastValue) setStatus(ctx, lastValue);

  try {
    const value = await fetchValue(ctx);
    if (generation !== requestGeneration || !isCopilot(ctx)) return undefined;
    lastValue = value;
    if (warned) {
      warned = false;
      console.error("[copilot-window-usage] quota fetch recovered");
    }
    setStatus(ctx, value);
    return value;
  } catch (err) {
    if (generation === requestGeneration && !lastValue) {
      setStatus(ctx, undefined);
    }
    if (!warned && generation === requestGeneration) {
      warned = true;
      console.error(
        `[copilot-window-usage] quota fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }
}

export default function copilotWindowUsage(pi: ExtensionAPI): void {
  // Fire-and-forget: pi awaits session_start/model_select handlers, so awaiting the
  // quota round-trip here blocks TUI startup (~400ms) and the model picker. The
  // requestGeneration guard in refresh() already discards stale responses.
  pi.on("session_start", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    requestGeneration += 1;
    setStatus(ctx, undefined);
  });

  pi.registerCommand("copilot-window", {
    description: "Refresh the compact GitHub Copilot premium quota window",
    handler: async (_args, ctx) => {
      if (!isCopilot(ctx)) {
        setStatus(ctx, undefined);
        ctx.ui.notify("Copilot usage is only shown for github-copilot models", "info");
        return;
      }

      const value = await refresh(ctx);
      ctx.ui.notify(value ?? "Copilot usage is unavailable", value ? "info" : "error");
    },
  });
}
