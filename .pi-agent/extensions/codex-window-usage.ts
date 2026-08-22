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

let requestGeneration = 0;
let lastValue: string | undefined;

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

function selectWindow(usage: UsageResponse): UsageWindow | undefined {
  const windows = [
    usage.rate_limit?.primary_window,
    usage.rate_limit?.secondary_window,
  ].filter((window): window is UsageWindow => {
    return (
      window != null &&
      typeof window.used_percent === "number" &&
      windowSeconds(window) !== undefined
    );
  });

  // Prefer the longest reported window (normally the 7-day quota).
  return windows.sort(
    (left, right) => (windowSeconds(right) ?? 0) - (windowSeconds(left) ?? 0),
  )[0];
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatWindow(window: UsageWindow, nowMs = Date.now()): string | undefined {
  const totalSeconds = windowSeconds(window);
  const usedPercent = window.used_percent;
  if (totalSeconds === undefined || typeof usedPercent !== "number") return undefined;

  let remainingSeconds: number | undefined;
  if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
    const resetAtSeconds =
      window.reset_at > 10_000_000_000 ? window.reset_at / 1000 : window.reset_at;
    remainingSeconds = resetAtSeconds - nowMs / 1000;
  } else if (
    typeof window.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds)
  ) {
    remainingSeconds = window.reset_after_seconds;
  }

  if (remainingSeconds === undefined) return undefined;

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

async function fetchValue(ctx: ExtensionContext): Promise<string> {
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
    const window = selectWindow(usage);
    const value = window ? formatWindow(window) : undefined;
    if (!value) throw new Error("no timed usage window was returned");
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function refresh(ctx: ExtensionContext): Promise<string | undefined> {
  const generation = ++requestGeneration;

  if (!isCodex(ctx)) {
    setStatus(ctx, undefined);
    return undefined;
  }

  if (lastValue) setStatus(ctx, lastValue);

  try {
    const value = await fetchValue(ctx);
    if (generation !== requestGeneration || !isCodex(ctx)) return undefined;
    lastValue = value;
    setStatus(ctx, value);
    return value;
  } catch {
    if (generation === requestGeneration && !lastValue) {
      setStatus(ctx, undefined);
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

      const value = await refresh(ctx);
      ctx.ui.notify(value ?? "Codex usage is unavailable", value ? "info" : "error");
    },
  });
}
