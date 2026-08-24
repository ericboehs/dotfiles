import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "xai";
const STATUS_KEY = "grok-window";
const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const REQUEST_TIMEOUT_MS = 10_000;

interface UsageWindow {
  used_percent: number;
  reset_at: number;
  limit_window_seconds: number;
}

interface WeeklyParse {
  window: UsageWindow;
  inferred: boolean;
  unified: boolean;
}

let requestGeneration = 0;
let lastValue: string | undefined;
// Log only the first failure of a streak (and the recovery) so a dead token
// doesn't spam the console on every settle.
let warned = false;

function isSuperGrok(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return model?.provider === PROVIDER && ctx.modelRegistry.isUsingOAuth(model);
}

function setStatus(ctx: ExtensionContext, value?: string): void {
  ctx.ui.setStatus(STATUS_KEY, value);
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

function parseMonthly(payload: unknown): UsageWindow | undefined {
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

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatWindow(window: UsageWindow, nowMs = Date.now()): string | undefined {
  const totalSeconds = window.limit_window_seconds;
  if (!(totalSeconds > 0)) return undefined;

  const remainingSeconds = window.reset_at - nowMs / 1000;
  const elapsedSeconds = Math.max(0, Math.min(totalSeconds, totalSeconds - remainingSeconds));
  const percent = Math.max(0, Math.min(100, window.used_percent));
  const expectedPercent = (elapsedSeconds / totalSeconds) * 100;
  const pointsAhead = percent - expectedPercent;
  const warningCount = pointsAhead > 20 ? 3 : pointsAhead > 10 ? 2 : pointsAhead > 5 ? 1 : 0;
  const warning = "!".repeat(warningCount);

  if (totalSeconds >= 86_400) {
    const elapsedDays = elapsedSeconds / 86_400;
    const totalDays = totalSeconds / 86_400;
    return `${formatNumber(elapsedDays)}/${formatNumber(totalDays)}D: ${formatNumber(percent)}%${warning}`;
  }

  const elapsedHours = elapsedSeconds / 3_600;
  const totalHours = totalSeconds / 3_600;
  return `${formatNumber(elapsedHours)}/${formatNumber(totalHours)}H: ${formatNumber(percent)}%${warning}`;
}

async function fetchJson(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "x-xai-token-auth": "xai-grok-cli",
        "user-agent": "pi-grok-window/1.0",
      },
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

async function fetchValue(ctx: ExtensionContext): Promise<string> {
  const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER);
  const accessToken = resolved?.auth.apiKey;
  if (!accessToken) throw new Error("xAI subscription authentication is unavailable");
  // Paid API keys are a different product and must never hit this endpoint.
  if (accessToken.startsWith("xai-")) {
    throw new Error("xAI API keys are not SuperGrok");
  }

  const credits = await fetchJson(CREDITS_URL, accessToken);
  const weekly = parseWeekly(credits);
  const shouldProbeMonthly = !weekly || (weekly.inferred && weekly.unified);

  let monthly: UsageWindow | undefined;
  if (shouldProbeMonthly) {
    try {
      monthly = parseMonthly(await fetchJson(MONTHLY_URL, accessToken));
    } catch (err) {
      // A real weekly percent can still stand alone if the monthly probe fails.
      if (!weekly || weekly.inferred) throw err;
    }
  }

  const window = weekly && !(weekly.inferred && monthly) ? weekly.window : monthly;
  const value = window ? formatWindow(window) : undefined;
  if (!value) throw new Error("no SuperGrok usage window was returned");
  return value;
}

async function refresh(ctx: ExtensionContext): Promise<string | undefined> {
  const generation = ++requestGeneration;

  if (!isSuperGrok(ctx)) {
    setStatus(ctx, undefined);
    return undefined;
  }

  if (lastValue) setStatus(ctx, lastValue);

  try {
    const value = await fetchValue(ctx);
    if (generation !== requestGeneration || !isSuperGrok(ctx)) return undefined;
    lastValue = value;
    if (warned) {
      warned = false;
      console.error("[grok-window-usage] usage fetch recovered");
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
        `[grok-window-usage] usage fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }
}

export default function grokWindowUsage(pi: ExtensionAPI): void {
  // Fire-and-forget: pi awaits session_start/model_select handlers, so awaiting the
  // usage round-trip here blocks TUI startup and the model picker. The
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

  pi.registerCommand("grok-window", {
    description: "Refresh the compact SuperGrok usage window",
    handler: async (_args, ctx) => {
      if (!isSuperGrok(ctx)) {
        setStatus(ctx, undefined);
        ctx.ui.notify("SuperGrok usage is only shown for xAI subscription models", "info");
        return;
      }

      const value = await refresh(ctx);
      ctx.ui.notify(value ?? "SuperGrok usage is unavailable", value ? "info" : "error");
    },
  });
}
