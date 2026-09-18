/**
 * deepseek-peak-pricing — footer indicator for DeepSeek 4.1 Flash peak pricing.
 *
 * When a DeepSeek 4.1 Flash model is active, adds a line to the footer:
 *   ▲ peak pricing (12–18 UTC)   Mon–Fri 12:00–18:00 UTC (peak rates)
 *   ▽ off-peak pricing           all other times
 *
 * Selecting any other model clears the indicator. A 30 s timer re-evaluates
 * the window so the indicator flips right at the 12:00 / 18:00 UTC boundary.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// --- Configuration -----------------------------------------------------------

// Which models count as "DeepSeek 4.1 Flash" — all tokens must appear in the
// model id or display name, e.g. "deepseek/deepseek-4.1-flash", "DeepSeek 4.1 Flash".
const MODEL_TOKENS = [/deepseek/i, /4\.1/, /flash/i];

// Peak pricing window: Monday (1) – Friday (5), 12:00 inclusive → 18:00 exclusive, UTC.
const PEAK_DAYS = [1, 2, 3, 4, 5];
const PEAK_START_HOUR = 12;
const PEAK_END_HOUR = 18;

// How often to re-check the clock (so the flip happens without user input).
const CHECK_INTERVAL_MS = 30_000;

const STATUS_KEY = "deepseek-peak";

// -----------------------------------------------------------------------------

function isPeakPricingNow(): boolean {
	const now = new Date();
	const hour = now.getUTCHours();
	return PEAK_DAYS.includes(now.getUTCDay()) && hour >= PEAK_START_HOUR && hour < PEAK_END_HOUR;
}

function isTargetModel(model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	const haystack = `${model.id} ${model.name ?? ""}`;
	return MODEL_TOKENS.every((re) => re.test(haystack));
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let shown: "peak" | "off-peak" | undefined;

	function update(ctx: ExtensionContext) {
		if (!isTargetModel(ctx.model)) {
			if (shown !== undefined) {
				shown = undefined;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			return;
		}

		const next = isPeakPricingNow() ? "peak" : "off-peak";
		if (next === shown) return; // avoid pointless re-renders
		shown = next;

		const theme = ctx.ui.theme;
		ctx.ui.setStatus(
			STATUS_KEY,
			next === "peak"
				? theme.fg("warning", "▲ peak pricing (12–18 UTC)")
				: theme.fg("dim", "▽ off-peak pricing"),
		);
	}

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		update(ctx);
		stopTimer();
		// Keep the indicator honest across the 12:00 / 18:00 UTC boundaries.
		timer = setInterval(() => update(ctx), CHECK_INTERVAL_MS);
	});

	pi.on("model_select", (_event, ctx) => {
		// ctx.model is already the newly selected model when handlers run.
		update(ctx);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		shown = undefined;
	});
}