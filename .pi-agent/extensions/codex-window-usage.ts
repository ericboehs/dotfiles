import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-window";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;

interface UsageWindow {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
  window_minutes?: number;
}

interface UsageResponse {
  rate_limit?: {
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  };
}

interface UsageDisplay {
  value: string;
  resetSummary: string;
}

let requestGeneration = 0;
let lastValue: string | undefined;
// Log only the first failure of a streak (and the recovery) so a dead token
// doesn't spam the console on every settle.
let warned = false;

function isCodex(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === PROVIDER;
}

function setStatus(ctx: ExtensionContext, value?: string): void {
  ctx.ui.setStatus(STATUS_KEY, value);
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

function selectWindows(usage: UsageResponse): UsageWindow[] {
  return [
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
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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

function formatWindow(window: UsageWindow, nowMs = Date.now()): string | undefined {
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

  if (totalSeconds >= 86_400) {
    const elapsedDays = elapsedSeconds / 86_400;
    const totalDays = totalSeconds / 86_400;
    return `${formatNumber(elapsedDays)}/${formatNumber(totalDays)}D: ${formatNumber(percent)}%${warning}`;
  }

  const elapsedHours = elapsedSeconds / 3_600;
  const totalHours = totalSeconds / 3_600;
  return `${formatNumber(elapsedHours)}/${formatNumber(totalHours)}H: ${formatNumber(percent)}%${warning}`;
}

async function fetchDisplay(ctx: ExtensionContext): Promise<UsageDisplay> {
  const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER);
  const accessToken = resolved?.auth.apiKey;
  if (!accessToken) throw new Error("OpenAI Codex authentication is unavailable");

  const accountId = accountIdFromJwt(accessToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        accept: "application/json",
        "user-agent": "pi-codex-window/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`usage request failed (${response.status})`);
    }

    const usage = (await response.json()) as UsageResponse;
    const windows = selectWindows(usage);
    const nowMs = Date.now();
    const value = windows
      .map((window) => formatWindow(window, nowMs))
      .filter((formatted): formatted is string => formatted !== undefined)
      .join(" ");
    if (!value) throw new Error("no timed usage window was returned");

    const resetSummary = windows
      .map((window) => formatReset(window, nowMs))
      .filter((formatted): formatted is string => formatted !== undefined)
      .join(" ");
    return { value, resetSummary };
  } finally {
    clearTimeout(timeout);
  }
}

async function refresh(ctx: ExtensionContext): Promise<UsageDisplay | undefined> {
  const generation = ++requestGeneration;

  if (!isCodex(ctx)) {
    setStatus(ctx, undefined);
    return undefined;
  }

  if (lastValue) setStatus(ctx, lastValue);

  try {
    const display = await fetchDisplay(ctx);
    if (generation !== requestGeneration || !isCodex(ctx)) return undefined;
    lastValue = display.value;
    if (warned) {
      warned = false;
      console.error("[codex-window-usage] usage fetch recovered");
    }
    setStatus(ctx, display.value);
    return display;
  } catch (err) {
    if (generation === requestGeneration && !lastValue) {
      setStatus(ctx, undefined);
    }
    if (!warned && generation === requestGeneration) {
      warned = true;
      console.error(
        `[codex-window-usage] usage fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }
}

export default function codexWindowUsage(pi: ExtensionAPI): void {
  // Fire-and-forget: pi awaits session_start/model_select handlers, so awaiting the
  // usage round-trip here blocks TUI startup (~400ms) and the model picker. The
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

  pi.registerCommand("codex-window", {
    description: "Refresh the compact Codex usage window",
    handler: async (_args, ctx) => {
      if (!isCodex(ctx)) {
        setStatus(ctx, undefined);
        ctx.ui.notify("Codex usage is only shown for openai-codex models", "info");
        return;
      }

      const display = await refresh(ctx);
      ctx.ui.notify(
        display
          ? `${display.value}\nResets: ${display.resetSummary}`
          : "Codex usage is unavailable",
        display ? "info" : "error",
      );
    },
  });
}
