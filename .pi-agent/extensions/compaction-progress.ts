/**
 * Compaction Progress Extension for pi
 *
 * Adds an animated progress bar with a self-correcting countdown ETA beneath
 * pi's built-in "Compacting context..." row, then reports how long it took:
 *
 *   [compaction] Compacted from 101,377 tokens (ctrl+r to expand)
 *     ████████████████░░░░░░░░░░░░  ~42s left · 70.5k tokens
 *     ████████████████████████████  +8s over estimate · 70.5k tokens
 *     ✓ Summarized from 101,377 tokens in 52s · est. 44s
 *     ✓ Rolled over from 101,377 tokens · no summarizer
 *
 * /tree still paints every compaction as [compaction: Nk tokens]. On first
 * paint we swap that substring to [Rolled over: Nk tokens] or
 * [Summarized: Nk tokens] so the picker matches the completion line. Search
 * finds those words too. If a future pi drops getEntryDisplayText, rows stay
 * stock; we do not write session labels.
 *
 * Compaction is a single LLM call, so there is no real percent-complete
 * signal. This estimates a total duration from the context size using a
 * throughput rate LEARNED from your own past compactions, persisted per-model
 * in ~/.pi/agent/compaction-rates.json. An unseen model borrows the median of
 * all recorded models before falling back to a conservative default.
 *
 * If the estimate runs out mid-flight, the bar completes and the countdown
 * flips to a count-up ("+8s over estimate") rather than stretching the
 * timeline or faking further progress. The overrun is honest feedback, and the
 * learned rate absorbs it for next time.
 *
 * Rate limits are handled honestly. On a 429/5xx the bar FREEZES and says
 * "rate limited" instead of faking motion, backoff time is excluded from the
 * ETA, and the run is disqualified from teaching the estimator a bogus rate.
 *
 * Install: drop this file in ~/.pi/agent/extensions/ (global) or
 * .pi/extensions/ (project), then run /reload.
 *
 * Events used:
 *   session_start            -> patch /tree compaction row labels (TUI only)
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
function stateFile(): string {
	return join(
		process.env.HOME || process.env.USERPROFILE || "~",
		".pi/agent/compaction-rates.json",
	);
}

// Cold-start assumption before any samples exist.
// Compaction time = a large fixed cost + a small per-token cost. Measured
// runs: 54k tokens took 61s while 212k took 91s, i.e. 4x the context for only
// 1.5x the time. These defaults apply only until real samples are recorded.
const DEFAULT_BASE_SEC = 35;
const DEFAULT_TOKENS_PER_SEC = 5_000;
const MIN_SAMPLES_FOR_FIT = 3;
const MIN_ETA_SEC = 8;

// The estimate is deliberately unbiased (no padding): the bar counts down to
// zero and then counts UP, showing exactly how wrong the estimate was.
// Raise above 1.0 to pad the ETA if you'd rather rarely see an overrun.
const SAFETY_MARGIN = 1.0;

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
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

/**
 * Estimated seconds for a compaction, using an AFFINE model:
 *
 *     sec = base + tokens / rate
 *
 * Compaction time is dominated by a fixed cost (request latency plus
 * generating a summary whose length barely varies with input size). Measured
 * runs show ~4x the context taking only ~1.5x the time, so a purely
 * proportional tokens/sec model wildly under-predicts small compactions.
 *
 * With enough spread in sample sizes we least-squares fit both terms per
 * model; otherwise we hold `base` fixed and solve for the rate. Falls back to
 * a pooled fit across all models so a brand-new model still starts sane.
 */
function estimateSec(key: string, tokens: number): number | undefined {
	try {
		const file = stateFile();
		if (!existsSync(file)) return undefined;
		const state = JSON.parse(readFileSync(file, "utf8"));
		const own = ((state[key] ?? []) as RateSample[]).slice(-8);
		const pool = own.length
			? own
			: (Object.values(state) as RateSample[][]).flatMap((s) => s.slice(-8));
		if (pool.length === 0) return undefined;

		const { base, rate } = fitModel(pool);
		return base + tokens / rate;
	} catch {
		return undefined;
	}
}

function fitModel(samples: RateSample[]): { base: number; rate: number } {
	const n = samples.length;
	const sizes = samples.map((s) => s.tokens);
	const spread = Math.max(...sizes) / Math.max(1, Math.min(...sizes));

	// Enough points AND enough size variation to separate the two terms.
	if (n >= MIN_SAMPLES_FOR_FIT && spread >= 1.5) {
		const mx = samples.reduce((a, s) => a + s.tokens, 0) / n;
		const my = samples.reduce((a, s) => a + s.sec, 0) / n;
		let sxy = 0;
		let sxx = 0;
		for (const s of samples) {
			sxy += (s.tokens - mx) * (s.sec - my);
			sxx += (s.tokens - mx) ** 2;
		}
		const slope = sxx > 0 ? sxy / sxx : 0;
		const intercept = my - slope * mx;
		// Reject nonsense fits (negative slope = "bigger is faster").
		if (slope > 0 && intercept > 0) {
			return {
				base: clamp(intercept, 2, 300),
				rate: clamp(1 / slope, 200, 500_000),
			};
		}
	}

	// Too few / too similar samples: hold the base fixed and solve for the rate.
	// Keep the base under the fastest observed run or the rate goes negative.
	const fastest = Math.min(...samples.map((s) => s.sec));
	const base = Math.min(DEFAULT_BASE_SEC, fastest * 0.6);
	const rates = samples
		.map((s) => s.tokens / Math.max(0.5, s.sec - base))
		.filter((r) => Number.isFinite(r) && r > 0);
	return { base, rate: median(rates) ?? DEFAULT_TOKENS_PER_SEC };
}

function recordRate(key: string, tokens: number, sec: number): void {
	try {
		const file = stateFile();
		const state = existsSync(file)
			? JSON.parse(readFileSync(file, "utf8"))
			: {};
		const list: RateSample[] = state[key] ?? [];
		list.push({ tokens, sec, at: new Date().toISOString() });
		state[key] = list.slice(-20);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(state, null, "\t"));
	} catch {
		// Best-effort persistence; never break compaction UX over stats.
	}
}

const WINDOW_KIND = "window-mode/v1";
// Own-property flag so /reload does not wrap TreeSelectorComponent.render twice.
const TREE_PATCH = "__compactionTreeLabeled";

/** Window-mode checkpoint rollover vs ordinary LLM summary. */
export function compactionTreeKind(
	entry: { type?: string; details?: unknown } | undefined,
): "Rolled over" | "Summarized" | undefined {
	if (entry?.type !== "compaction") return;
	const kind = (entry.details as { kind?: string } | undefined)?.kind;
	return kind === WINDOW_KIND ? "Rolled over" : "Summarized";
}

/** Swap pi's baked [compaction: Nk tokens] for Rolled over / Summarized. */
export function relabelCompactionRow(
	text: string,
	entry: { type?: string; tokensBefore?: number; details?: unknown } | undefined,
): string {
	const kind = compactionTreeKind(entry);
	if (!kind || typeof entry?.tokensBefore !== "number") return text;
	const tokens = Math.round(entry.tokensBefore / 1000);
	const from = `[compaction: ${tokens}k tokens]`;
	const to = `[${kind}: ${tokens}k tokens]`;
	return text.includes(from) ? text.replace(from, to) : text;
}

function labelTreeList(list: any): void {
	if (!list || list[TREE_PATCH]) return;
	list[TREE_PATCH] = true;
	const display = list.getEntryDisplayText;
	const search = list.getSearchableText;
	if (typeof display === "function") {
		list.getEntryDisplayText = function (node: { entry?: unknown }, isSelected: boolean) {
			return relabelCompactionRow(String(display.call(this, node, isSelected) ?? ""), node?.entry as { type?: string; tokensBefore?: number; details?: unknown });
		};
	}
	if (typeof search === "function") {
		list.getSearchableText = function (node: { entry?: unknown }) {
			const text = String(search.call(this, node) ?? "");
			const kind = compactionTreeKind(node?.entry as { type?: string; details?: unknown });
			return kind ? `${text} ${kind}` : text;
		};
	}
}

/** Wrap TreeSelectorComponent so /tree rows distinguish rollover vs summary. */
export function patchTreeSelector(Ctor: { prototype: any }): boolean {
	const proto = Ctor.prototype;
	if (!proto) return false;
	if (proto[TREE_PATCH]) return true;
	const original = proto.render;
	if (typeof original !== "function") return false;
	proto[TREE_PATCH] = true;
	proto.render = function (this: { treeList?: unknown }, width: number) {
		labelTreeList(this.treeList);
		return original.call(this, width);
	};
	return true;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let reportShown = false; // completion line is up, awaiting the next turn
	let startedAt = 0;
	let tokensBefore = 0;
	let etaTotalSec = 0; // current estimated total duration (grows via revisions)
	let lastShownFill = 0; // monotonic clamp so the bar never moves backward
	let blockedSince: number | undefined; // set while the provider is erroring/backing off
	let blockedTotalSec = 0; // accumulated time NOT spent actually compacting
	let retryAfterSec: number | undefined; // from Retry-After header, when present
	let errorCount = 0; // any provider error disqualifies the timing sample
	let treePatchAttempted = false;

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
		const filled = FILL_STEPS[FILL_STEPS.length - 1]!.repeat(whole) + FILL_STEPS[fracIdx]!;
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

		// The bar fills linearly and completes exactly when the estimate says it
		// should. Past that we stop pretending: the countdown flips to a count-up
		// showing how far over the estimate we are.
		const overSec = elapsedSec - etaTotalSec;
		lastShownFill = Math.max(lastShownFill, Math.min(1, elapsedSec / etaTotalSec));
		const { filled, rest } = renderBar(lastShownFill);

		// pi already renders its own "Compacting context..." loader row above
		// this widget, so show only the bar -- no duplicate label or spinner.
		const remainingSec = Math.max(0, Math.ceil(-overSec));
		const status =
			overSec >= 1
				? `+${fmtDuration(overSec)} over estimate`
				: remainingSec > 0
					? `~${remainingSec}s left`
					: "finishing up...";
		const timeText = `${status} · ${fmtTokens(tokensBefore)} tokens`;

		const line =
			theme.fg(overSec >= 1 ? "warning" : "accent", `  ${filled}`) +
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
				SAFETY_MARGIN *
					(estimateSec(modelKey((ctx as any).model), tokensBefore) ??
						DEFAULT_BASE_SEC + tokensBefore / DEFAULT_TOKENS_PER_SEC),
			),
		);
		lastShownFill = 0;
		blockedSince = undefined;
		blockedTotalSec = 0;
		retryAfterSec = undefined;
		errorCount = 0;

		// First paint on the interval, not now. Window-mode rollovers finish in
		// this same turn and replace the widget with the "Rolled over" line;
		// drawing immediately would flash a fake summarizer bar.
		timer = setInterval(() => draw(ctx, ctx.ui.theme), TICK_MS);

		event.signal?.addEventListener("abort", () => stop(ctx), { once: true });
	}

	function stop(ctx: any, success = false, tokens?: number, learn = true, rolledOver = false) {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
		const wallSec = startedAt > 0 ? (Date.now() - startedAt) / 1000 : 0;
		const stalledSec = blockedTotalSec + (blockedSince ? (Date.now() - blockedSince) / 1000 : 0);

		// Only learn from clean runs: a sample polluted by rate-limit backoff
		// would teach the estimator a throughput far slower than reality.
		if (success && learn && startedAt > 0 && tokensBefore > 0 && errorCount === 0) {
			recordRate(modelKey((ctx as any)?.model), tokensBefore, activeSeconds());
		}

		const shouldReport = success && startedAt > 0;
		const reportTokens = tokens ?? tokensBefore;
		startedAt = 0;
		blockedSince = undefined;

		if (!shouldReport) {
			reportShown = false;
			ctx?.ui?.setWidget(WIDGET_ID, undefined);
			return;
		}

		// pi's own "[compaction] Compacted from N tokens" entry does not say how
		// the cut happened. This line distinguishes a checkpoint rollover from an
		// LLM summary, and for summaries includes duration. It stays up until the
		// next turn -- compaction often finishes while you're looking away.
		const theme = ctx?.ui?.theme;
		const stalledNote =
			stalledSec >= 1 ? ` (${fmtDuration(stalledSec)} rate limited)` : "";
		// Show how far off the estimate was, so the calibration is visible.
		const estSec = etaTotalSec;
		const estNote =
			estSec > 0 && Math.abs(wallSec - estSec) >= 2
				? ` · est. ${fmtDuration(estSec)}`
				: "";
		const text = rolledOver
			? `✓ Rolled over from ${reportTokens.toLocaleString()} tokens · no summarizer`
			: `✓ Summarized from ${reportTokens.toLocaleString()} tokens in ${fmtDuration(wallSec)}${stalledNote}${estNote}`;
		ctx?.ui?.setWidget(WIDGET_ID, [
			theme ? theme.fg("dim", `  ${text}`) : `  ${text}`,
		]);
		reportShown = true;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || treePatchAttempted) return;
		treePatchAttempted = true;
		try {
			const { TreeSelectorComponent } = await import("@earendil-works/pi-coding-agent");
			patchTreeSelector(TreeSelectorComponent);
		} catch {
			// Print mode, tests, or an older pi: keep stock [compaction: Nk tokens] rows.
		}
	});

	// Clear the completion line when the next turn begins, not on a timer.
	pi.on("turn_start", async (_event, eventCtx) => {
		if (!reportShown) return;
		reportShown = false;
		eventCtx?.ui?.setWidget(WIDGET_ID, undefined);
	});

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
		// Checkpoint rollovers do not call a summarizer. Timing them as model
		// throughput would corrupt estimates for subsequent ordinary compactions.
		const checkpointRollover =
			compactionTreeKind(event.compactionEntry) === "Rolled over";
		stop(eventCtx, true, event.compactionEntry?.tokensBefore, !checkpointRollover, checkpointRollover);
	});

	pi.on("session_compact_failed", async (_event, eventCtx) => {
		stop(eventCtx, false);
	});

	pi.on("session_shutdown", async (_event, eventCtx) => {
		stop(eventCtx, false);
	});
}
