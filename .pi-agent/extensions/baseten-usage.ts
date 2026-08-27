import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "baseten";
const USAGE_URL = "https://api.baseten.co/v1/billing/usage_summary";
const REQUEST_TIMEOUT_MS = 10_000;
// Baseten updates billing data hourly; avoid re-fetching on every settle.
const CACHE_TTL_MS = 5 * 60 * 1000;
// Optional: set to a dollar amount to see % of budget in the status line.
const BUDGET_ENV_VAR = "BASETEN_MONTHLY_BUDGET";

interface UsageSection {
  subtotal?: number | string;
  credits_used?: number | string;
  total?: number | string;
}

interface UsageResponse {
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

interface UsageDisplay {
  value: string;
  detail: string;
}

/** What footer.ts reads to render the MTD chip in the session-cost slot.
 *  A globalThis stash (color.ts's pattern) rather than an import: extensions
 *  are separate modules and a failed import aborts pi's whole launch. */
const STASH_KEY = "__piBasetenUsage";
/** Emitted after the stash updates so footer.ts can repaint immediately. */
const UPDATE_EVENT = "baseten-usage:updated";

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

function isBaseten(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === PROVIDER;
}

function toNumber(value: number | string | undefined): number {
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

/** Start of the current calendar month in UTC (Baseten budgets are monthly). */
function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function isoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function budget(): number | undefined {
  const raw = process.env[BUDGET_ENV_VAR];
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function fetchDisplay(): Promise<UsageDisplay> {
  const apiKey = process.env.BASETEN_API_KEY;
  if (!apiKey) throw new Error("BASETEN_API_KEY is not set");

  const now = new Date();
  const url = `${USAGE_URL}?start_date=${encodeURIComponent(isoUtc(monthStartUtc(now)))}&end_date=${encodeURIComponent(isoUtc(now))}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": "pi-baseten-usage/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`usage request failed (${response.status})`);
    }

    const usage = (await response.json()) as UsageResponse;
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

    const budgetAmount = budget();
    const budgetPart = budgetAmount
      ? ` / ${formatDollars(budgetAmount)} (${Math.round((grandTotal / budgetAmount) * 100)}%)`
      : "";
    const value = `${formatDollars(grandTotal)}${budgetPart}`;

    const detail = [`MTD total: ${formatDollars(grandTotal)} (net of ${formatDollars(grandCredits)} credits)`];
    detail.push(...(lines.length > 0 ? lines : ["No usage this month."]));

    const breakdown = usage.model_apis_usage?.breakdown;
    if (breakdown && breakdown.length > 0) {
      const top = [...breakdown]
        .sort(
          (left, right) => toNumber(right.subtotal) - toNumber(left.subtotal),
        )
        .slice(0, 5);
      detail.push("Top models:");
      for (const entry of top) {
        const sub = toNumber(entry.subtotal);
        detail.push(
          `  ${entry.model_name ?? "unknown"}: ${formatDollars(sub)}`,
        );
      }
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

  if (!isBaseten(ctx)) return undefined;

  const cached = lastDisplay && Date.now() - lastFetchMs < CACHE_TTL_MS;
  if (cached && !options.force) return lastDisplay;

  try {
    const display = await fetchDisplay();
    if (generation !== requestGeneration || !isBaseten(ctx)) return undefined;
    lastDisplay = display;
    lastFetchMs = Date.now();
    stashWrite(display);
    if (warned) {
      warned = false;
      console.error("[baseten-usage] usage fetch recovered");
    }
    // The footer reads the stash during renders; poke it so the new value
    // paints immediately instead of waiting for the next render event.
    pi.events.emit(UPDATE_EVENT);
    return display;
  } catch (err) {
    if (!warned && generation === requestGeneration) {
      warned = true;
      console.error(
        `[baseten-usage] usage fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }
}

export default function basetenUsage(pi: ExtensionAPI): void {
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

  pi.registerCommand("baseten-usage", {
    description: "Show Baseten month-to-date billing usage",
    handler: async (_args, ctx) => {
      if (!isBaseten(ctx)) {
        ctx.ui.notify(
          "Baseten usage is only shown for baseten models",
          "info",
        );
        return;
      }

      const display = await refresh(pi, ctx, { force: true });
      ctx.ui.notify(
        display ? display.detail : "Baseten usage is unavailable",
        display ? "info" : "error",
      );
    },
  });
}
