/**
 * Compaction Progress Extension for pi
 *
 * Adds an animated progress bar with a self-correcting countdown ETA beneath
 * pi's built-in "Compacting context..." row, then reports how long it took:
 *
 *   [compaction] Compacted from 101,377 tokens (ctrl+r to expand)
 *     ████████████████░░░░░░░░░░░░  ~42s left · 70.5k tokens
 *     ✓ Compacted from 101,377 tokens in 52s
 *
 * Compaction is a single LLM call, so there is no real percent-complete
 * signal. This estimates a total duration from the context size using a
 * throughput rate LEARNED from your own past compactions, persisted per-model
 * in ~/.pi/agent/compaction-rates.json. An unseen model borrows the median of
 * all recorded models before falling back to a conservative default.
 *
 * If the estimate runs out mid-flight it revises itself: the timeline stretches
 * from the bar's current position, so the bar pauses and resumes climbing
 * rather than jumping backward or parking at 100%.
 *
 * Rate limits are handled honestly. On a 429/5xx the bar FREEZES and says
 * "rate limited" instead of faking motion, backoff time is excluded from the
 * ETA, and the run is disqualified from teaching the estimator a bogus rate.
 *
 * Install: drop this file in ~/.pi/agent/extensions/ (global) or
 * .pi/extensions/ (project), then run /reload.
 *
 * Events used:
 *   session_before_compact   -> start animation
 *   after_provider_response  -> detect 429/5xx stalls
 *   session_compact          -> stop, report duration, record rate sample
 *   session_compact_failed   -> stop animation
 *   session_shutdown         -> cleanup
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const WIDGET_ID = "compaction-progress";
const BAR_WIDTH = 28;
const TICK_MS = 100;
const STATE_FILE = join(
	process.env.HOME || process.env.USERPROFILE || "~",
	".pi/agent/compaction-rates.json",
);

// Cold-start assumption before any samples exist. This is end-to-end
// summarization throughput (includes latency + output generation), NOT raw
// prefill speed -- measured runs land around 900-1500 tok/s, so start low.
// Real samples override this as soon as one clean run is recorded.
const DEFAULT_TOKENS_PER_SEC = 1_000;
const MIN_ETA_SEC = 8;

// Pad the ETA so the bar usually completes just BEFORE reality does.
const SAFETY_MARGIN = 1.15;

// The bar never rises past this; the final stretch shows "finishing up...".
const FILL_CAP = 0.9;

// How long the "Compacted from N tokens in Xs" result stays on screen.
const LINGER_MS = 6_000;

// Partial-fill characters for smooth sub-cell progress ("█" is full).
const FILL_STEPS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

interface RateSample {
	tokens: number;
	sec: number;
	at: string; // ISO timestamp
}

function modelKey(model: any): string {
	if (!model) return "_default";
	return model.id ?? model.modelId ?? `${model.provider ?? "?"}/${model.name ?? "?"}`;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median tokens/sec for a model, falling back to a global median across all
 * models so a brand-new model still gets a realistic first estimate.
 */
function learnedRate(key: string): number | undefined {
	try {
		if (!existsSync(STATE_FILE)) return undefined;
		const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		const toRates = (samples: RateSample[]) =>
			samples.map((s) => s.tokens / Math.max(s.sec, 0.5));

		const own = median(toRates((state[key] ?? []).slice(-8)));
		if (own !== undefined) return own;

		const all = Object.values(state).flatMap((samples) =>
			toRates((samples as RateSample[]).slice(-8)),
		);
		return median(all);
	} catch {
		return undefined;
	}
}

function recordRate(key: string, tokens: number, sec: number): void {
	try {
		const state = existsSync(STATE_FILE)
			? JSON.parse(readFileSync(STATE_FILE, "utf8"))
			: {};
		const list: RateSample[] = state[key] ?? [];
		list.push({ tokens, sec, at: new Date().toISOString() });
		state[key] = list.slice(-20);
		mkdirSync(join(STATE_FILE, ".."), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(state, null, "\t"));
	} catch {
		// Best-effort persistence; never break compaction UX over stats.
	}
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lingerTimer: ReturnType<typeof setTimeout> | undefined;
	let startedAt = 0;
	let tokensBefore = 0;
	let etaTotalSec = 0; // current estimated total duration (grows via revisions)
	let lastShownFill = 0; // monotonic clamp so the bar never moves backward
	let blockedSince: number | undefined; // set while the provider is erroring/backing off
	let blockedTotalSec = 0; // accumulated time NOT spent actually compacting
	let retryAfterSec: number | undefined; // from Retry-After header, when present
	let errorCount = 0; // any provider error disqualifies the timing sample

	/** Wall time minus any time spent blocked on provider errors. */
	function activeSeconds(): number {
		const wall = (Date.now() - startedAt) / 1000;
		const blockedNow = blockedSince ? (Date.now() - blockedSince) / 1000 : 0;
		return Math.max(0, wall - blockedTotalSec - blockedNow);
	}

	function fmtDuration(sec: number): string {
		if (sec < 60) return `${Math.round(sec)}s`;
		const m = Math.floor(sec / 60);
		const s = Math.round(sec % 60);
		return s === 0 ? `${m}m` : `${m}m ${s}s`;
	}

	function fmtTokens(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return String(n);
	}

	function renderBar(p: number): { filled: string; rest: string } {
		const exact = Math.max(0, Math.min(1, p)) * BAR_WIDTH;
		const whole = Math.floor(exact);
		const fracIdx = Math.round((exact - whole) * (FILL_STEPS.length - 1));
		const filled = FILL_STEPS[FILL_STEPS.length - 1].repeat(whole) + FILL_STEPS[fracIdx];
		const rest = "░".repeat(Math.max(0, BAR_WIDTH - whole - (fracIdx > 0 ? 1 : 0)));
		return { filled, rest };
	}

	function draw(ctx: any, theme: import("@earendil-works/pi-coding-agent").Theme) {
		// While blocked on a provider error, freeze the bar and say so plainly.
		// The countdown does not tick down during backoff, because no
		// compaction work is actually happening.
		if (blockedSince !== undefined) {
			const waitedSec = Math.floor((Date.now() - blockedSince) / 1000);
			const { filled, rest } = renderBar(lastShownFill);
			const hint = retryAfterSec
				? `retry in ~${Math.max(0, retryAfterSec - waitedSec)}s`
				: `waiting ${waitedSec}s`;

			ctx.ui.setWidget(WIDGET_ID, [
				theme.fg("warning", `  ${filled}`) +
					theme.fg("dim", rest) +
					theme.fg("warning", `  rate limited, ${hint}`),
			]);
			return;
		}

		const elapsedSec = activeSeconds();

		// Self-correct: if the estimate ran out, stretch the timeline so the
		// bar resumes from where it is now (no jump, no parking at full) and
		// keeps climbing steadily toward FILL_CAP.
		if (elapsedSec >= etaTotalSec) {
			const anchor = Math.min(FILL_CAP, Math.max(lastShownFill, 0.45));
			etaTotalSec = elapsedSec / anchor;
		}

		lastShownFill = Math.max(
			lastShownFill,
			Math.min(FILL_CAP, elapsedSec / etaTotalSec),
		);
		const { filled, rest } = renderBar(lastShownFill);

		// pi already renders its own "Compacting context..." loader row above
		// this widget, so show only the bar -- no duplicate label or spinner.
		const remainingSec = Math.max(0, Math.ceil(etaTotalSec - elapsedSec));
		const timeText =
			(remainingSec > 0 ? `~${remainingSec}s left` : "finishing up...") +
			` · ${fmtTokens(tokensBefore)} tokens`;

		const line =
			theme.fg("accent", `  ${filled}`) +
			theme.fg("dim", rest) +
			theme.fg("dim", `  ${timeText}`);

		ctx.ui.setWidget(WIDGET_ID, [line]);
	}

	function start(event: import("@earendil-works/pi-coding-agent").SessionBeforeCompactEvent, ctx: any) {
		stop(ctx);
		startedAt = Date.now();
		tokensBefore = event.preparation.tokensBefore ?? 0;
		etaTotalSec = Math.max(
			MIN_ETA_SEC,
			Math.round(
				SAFETY_MARGIN * (tokensBefore / (learnedRate(modelKey((ctx as any).model)) ?? DEFAULT_TOKENS_PER_SEC)),
			),
		);
		lastShownFill = 0;
		blockedSince = undefined;
		blockedTotalSec = 0;
		retryAfterSec = undefined;
		errorCount = 0;

		draw(ctx, ctx.ui.theme);
		timer = setInterval(() => draw(ctx, ctx.ui.theme), TICK_MS);

		event.signal?.addEventListener("abort", () => stop(ctx), { once: true });
	}

	function stop(ctx: any, success = false, tokens?: number) {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
		if (lingerTimer !== undefined) {
			clearTimeout(lingerTimer);
			lingerTimer = undefined;
		}
		const wallSec = startedAt > 0 ? (Date.now() - startedAt) / 1000 : 0;
		const stalledSec = blockedTotalSec + (blockedSince ? (Date.now() - blockedSince) / 1000 : 0);

		// Only learn from clean runs: a sample polluted by rate-limit backoff
		// would teach the estimator a throughput far slower than reality.
		if (success && startedAt > 0 && tokensBefore > 0 && errorCount === 0) {
			recordRate(modelKey((ctx as any)?.model), tokensBefore, activeSeconds());
		}

		const shouldReport = success && startedAt > 0;
		const reportTokens = tokens ?? tokensBefore;
		startedAt = 0;
		blockedSince = undefined;

		if (!shouldReport) {
			ctx?.ui?.setWidget(WIDGET_ID, undefined);
			return;
		}

		// pi's own "[compaction] Compacted from N tokens" entry has no timing,
		// so linger briefly with the duration before clearing.
		const theme = ctx?.ui?.theme;
		const stalledNote =
			stalledSec >= 1 ? ` (${fmtDuration(stalledSec)} rate limited)` : "";
		const text = `✓ Compacted from ${reportTokens.toLocaleString()} tokens in ${fmtDuration(wallSec)}${stalledNote}`;
		ctx?.ui?.setWidget(WIDGET_ID, [
			theme ? theme.fg("dim", `  ${text}`) : `  ${text}`,
		]);

		lingerTimer = setTimeout(() => {
			lingerTimer = undefined;
			ctx?.ui?.setWidget(WIDGET_ID, undefined);
		}, LINGER_MS);
	}

	pi.on("session_before_compact", async (event, eventCtx) => {
		start(event, eventCtx);
	});

	// Provider-level truth: while compaction is in flight, a 429/5xx means no
	// real progress is happening. Freeze the bar rather than faking motion.
	pi.on("after_provider_response", async (event) => {
		if (startedAt === 0) return; // not compacting

		const failed = event.status === 429 || event.status >= 500 || event.status === 408;
		if (failed) {
			if (blockedSince === undefined) blockedSince = Date.now();
			errorCount++;
			const header = event.headers?.["retry-after"] ?? event.headers?.["Retry-After"];
			const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
			retryAfterSec = Number.isFinite(parsed) ? parsed : undefined;
		} else if (blockedSince !== undefined) {
			// Recovered: bank the stalled time so it doesn't count against the ETA.
			blockedTotalSec += (Date.now() - blockedSince) / 1000;
			blockedSince = undefined;
			retryAfterSec = undefined;
		}
	});

	pi.on("session_compact", async (event, eventCtx) => {
		stop(eventCtx, true, event.compactionEntry?.tokensBefore);
	});

	pi.on("session_compact_failed", async (_event, eventCtx) => {
		stop(eventCtx, false);
	});

	pi.on("session_shutdown", async (_event, eventCtx) => {
		stop(eventCtx, false);
	});
}
