import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "openrouter";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const REQUEST_TIMEOUT_MS = 10_000;
// The key endpoint is cheap, but there is no point polling faster than the
// usage numbers move.
const CACHE_TTL_MS = 5 * 60 * 1000;
// Optional: set to a dollar amount to see % of budget in the footer chip.
const BUDGET_ENV_VAR = "OPENROUTER_MONTHLY_BUDGET";

/**
 * GET /api/v1/key describes the API key the request authenticated with.
 * `usage_monthly` is spend over the current UTC month — the same MTD window
 * the Baseten chip uses. BYOK usage is billed separately (5%) and reported
 * alongside.
 */
interface KeyData {
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  byok_usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
}

interface KeyResponse {
  data?: KeyData;
}

interface UsageDisplay {
  value: string;
  detail: string;
}

/** What footer.ts reads to render the MTD chip in the session-cost slot.
 *  A globalThis stash (color.ts's pattern) rather than an import: extensions
 *  are separate modules and a failed import aborts pi's whole launch. */
const STASH_KEY = "__piOpenRouterUsage";
/** Emitted after the stash updates so footer.ts can repaint immediately. */
const UPDATE_EVENT = "openrouter-usage:updated";

function stashWrite(display: UsageDisplay): void {
  (globalThis as Record<string, unknown>)[STASH_KEY] = {
    value: display.value,
    fetchedAt: Date.now(),
  };
}

let requestGeneration = 0;
let lastDisplay: UsageDisplay | undefined;
let lastFetchMs = 0;
// Log only the first failure of a streak (and the recovery) so a bad key
// doesn't spam the console on every settle.
let warned = false;

function isOpenRouter(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === PROVIDER;
}

function toNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatDollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function budget(): number | undefined {
  const raw = process.env[BUDGET_ENV_VAR];
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** The credential actually used for inference, with the env var as fallback. */
async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER);
    const key = resolved?.auth?.apiKey;
    if (typeof key === "string" && key) return key;
  } catch {
    // No stored auth; fall through to the environment.
  }
  return process.env.OPENROUTER_API_KEY || undefined;
}

async function fetchDisplay(apiKey: string): Promise<UsageDisplay> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(KEY_URL, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": "pi-openrouter-usage/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`key request failed (${response.status})`);
    }

    const { data } = (await response.json()) as KeyResponse;
    if (!data) throw new Error("key response had no data");

    const mtd = toNumber(data.usage_monthly);
    const byokMtd = toNumber(data.byok_usage_monthly);

    const budgetAmount = budget();
    const budgetPart = budgetAmount
      ? ` / ${formatDollars(budgetAmount)} (${Math.round((mtd / budgetAmount) * 100)}%)`
      : "";
    const value = `${formatDollars(mtd)}${budgetPart}`;

    const detail = [`MTD (UTC month): ${formatDollars(mtd)}`];
    if (byokMtd > 0) detail.push(`BYOK MTD: ${formatDollars(byokMtd)}`);
    detail.push(`Today: ${formatDollars(toNumber(data.usage_daily))}`);
    detail.push(`All-time on this key: ${formatDollars(toNumber(data.usage))}`);
    if (data.limit != null) {
      detail.push(
        `Key limit: ${formatDollars(toNumber(data.limit_remaining))} left of ${formatDollars(toNumber(data.limit))}`,
      );
    }

    return { value, detail: detail.join("\n") };
  } finally {
    clearTimeout(timeout);
  }
}

async function refresh(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { force?: boolean } = {},
): Promise<UsageDisplay | undefined> {
  const generation = ++requestGeneration;

  if (!isOpenRouter(ctx)) return undefined;

  const cached = lastDisplay && Date.now() - lastFetchMs < CACHE_TTL_MS;
  if (cached && !options.force) return lastDisplay;

  try {
    const apiKey = await resolveApiKey(ctx);
    if (!apiKey) throw new Error("no OpenRouter credential (pi auth or OPENROUTER_API_KEY)");

    const display = await fetchDisplay(apiKey);
    if (generation !== requestGeneration || !isOpenRouter(ctx)) return undefined;
    lastDisplay = display;
    lastFetchMs = Date.now();
    stashWrite(display);
    if (warned) {
      warned = false;
      console.error("[openrouter-usage] usage fetch recovered");
    }
    // The footer reads the stash during renders; poke it so the new value
    // paints immediately instead of waiting for the next render event.
    pi.events.emit(UPDATE_EVENT);
    return display;
  } catch (err) {
    if (!warned && generation === requestGeneration) {
      warned = true;
      console.error(
        `[openrouter-usage] usage fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }
}

export default function openRouterUsage(pi: ExtensionAPI): void {
  // Fire-and-forget: pi awaits session_start/model_select handlers, so awaiting the
  // usage round-trip here blocks TUI startup and the model picker. The
  // requestGeneration guard in refresh() already discards stale responses.
  pi.on("session_start", (_event, ctx) => {
    void refresh(pi, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    void refresh(pi, ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refresh(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    requestGeneration += 1;
  });

  pi.registerCommand("openrouter-usage", {
    description: "Show OpenRouter month-to-date key usage",
    handler: async (_args, ctx) => {
      if (!isOpenRouter(ctx)) {
        ctx.ui.notify(
          "OpenRouter usage is only shown for openrouter models",
          "info",
        );
        return;
      }

      const display = await refresh(pi, ctx, { force: true });
      ctx.ui.notify(
        display ? display.detail : "OpenRouter usage is unavailable",
        display ? "info" : "error",
      );
    },
  });
}
