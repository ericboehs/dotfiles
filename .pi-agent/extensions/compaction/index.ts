import { appendFileSync } from "node:fs";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	appendFileLists,
	buildReplayPayload,
	cacheIsWarm,
	cacheTtlMs,
	type CapturedRequest,
	clockLabel,
	contextIsLarge,
	fileLists,
	idleCompactEnabled,
	idleDelayMs,
	idleStatus,
	isSessionPayload,
	minPercent,
	minTokens,
	replayPrompt,
	replayTail,
	summaryRoom,
} from "./replay.ts";

/** ctx.ui.setStatus key for the footer chip; footer.ts renders it inline. */
export const IDLE_COMPACT_STATUS = "idle-compact";
import { summarizeWithoutThinking } from "./thoughtless.ts";

// Compaction, in one session_before_compact handler (pi runs every handler and
// keeps the last result, so two handlers would both pay for a summary):
//
//   1. Cache replay (replay.ts). Resend the session's last Anthropic request
//      with a summarize turn appended. The history is billed as a cache read.
//   2. Thoughtless summary (thoughtless.ts). The flattened-text summary with
//      thinking turned down, when the replay does not apply or fails.
//   3. pi's default compaction, for non-Anthropic models.
//
// Plus Claude Code's idle compaction: with the 1-hour cache
// (PI_CACHE_RETENTION=long), a session that sits idle with a large context is
// compacted 54 minutes after its last request, while the cache is still warm.
// Otherwise the next message, an hour later, rewrites the whole context at
// cache-write price.

export default function (pi: ExtensionAPI) {
	let captured: CapturedRequest | undefined;
	let compacting = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	// When the armed timer fires, for /idle.
	let idleFiresAt: number | undefined;
	// The ctx that armed the timer, to clear the footer chip with.
	let chipCtx: ExtensionContext | undefined;

	const setChip = (ctx: ExtensionContext | undefined, text: string | undefined) => {
		try {
			ctx?.ui.setStatus(IDLE_COMPACT_STATUS, text);
		} catch {
			// A ctx from a replaced session throws; its footer is gone anyway.
		}
	};

	const clearIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		idleFiresAt = undefined;
		setChip(chipCtx, undefined);
		chipCtx = undefined;
	};

	pi.on("before_provider_request", (event, ctx) => {
		// pi's own summaries and titles carry no tools; skip them, and anything
		// sent while a compaction is running.
		if (compacting || ctx.model?.api !== "anthropic-messages" || !isSessionPayload(event.payload)) return;
		captured = {
			payload: structuredClone(event.payload),
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			at: Date.now(),
			leafId: ctx.sessionManager.getLeafId(),
		};
	});

	pi.on("session_before_compact", async (event, ctx) => {
		compacting = true;
		clearIdleTimer();
		const replayed = await summarizeFromCache(event, ctx, captured);
		if (replayed) return replayed;
		if (event.signal.aborted) return;
		return summarizeWithoutThinking(event, ctx);
	});

	const settle = () => {
		compacting = false;
		// The captured payload no longer matches the compacted branch.
		captured = undefined;
	};
	pi.on("session_compact", settle);
	pi.on("session_compact_failed", () => {
		compacting = false;
	});

	pi.on("agent_settled", (_event, ctx) => {
		clearIdleTimer();
		if (!idleCompactEnabled() || !captured || ctx.model?.api !== "anthropic-messages") return;
		if (!contextIsLarge(ctx.getContextUsage(), minPercent(), minTokens())) return;
		// PI_IDLE_COMPACT_DELAY_MS replaces the 54-minute wait, for testing.
		const override = Number(process.env.PI_IDLE_COMPACT_DELAY_MS);
		const delay = override > 0 ? override : idleDelayMs(captured, Date.now(), cacheTtlMs());
		if (delay === undefined) return;
		const armedFor = captured;
		idleTimer = setTimeout(() => {
			clearIdleTimer();
			if (captured !== armedFor || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			ctx.ui.notify("Idle for 54 minutes: compacting while the prompt cache is still warm", "info");
			ctx.compact({
				onError: (error) => ctx.ui.notify(`Idle compaction failed: ${error.message}`, "warning"),
			});
		}, delay);
		idleTimer.unref?.();
		idleFiresAt = Date.now() + delay;
		// footer.ts shows this dim after the context chip.
		chipCtx = ctx;
		// The space: terminals draw ⏲ two cells wide, over the clock's first digit.
		setChip(ctx, `⏲ ${clockLabel(new Date(Date.now() + delay))}`);
	});

	// Any activity, a model switch or leaving the session cancels the timer.
	pi.on("input", () => clearIdleTimer());
	pi.on("agent_start", () => clearIdleTimer());
	pi.on("model_select", () => clearIdleTimer());
	pi.on("session_shutdown", () => {
		clearIdleTimer();
		captured = undefined;
	});

	pi.registerCommand("idle", {
		description: "Show whether idle compaction is armed, or why not",
		handler: async (_args, ctx) => {
			const text = idleStatus({
				env: process.env,
				api: ctx.model?.api,
				usage: ctx.getContextUsage(),
				captured,
				firesAt: idleFiresAt,
				now: Date.now(),
			});
			ctx.ui.notify(text, "info");
		},
	});
}

/**
 * Summarize by replaying the last real request with a summarize turn appended.
 * Returns undefined whenever the replay cannot hit the cache or does not yield
 * a clean summary, so the caller falls back.
 */
async function summarizeFromCache(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	captured: CapturedRequest | undefined,
) {
	const model = ctx.model;
	if (!captured || !model || model.api !== "anthropic-messages") return debug("no captured request");
	if (model.provider !== captured.provider || model.id !== captured.modelId) return debug("model changed");
	if (!cacheIsWarm(captured, Date.now(), cacheTtlMs())) return debug("cache cold");

	const { preparation, branchEntries, customInstructions, signal, reason } = event;
	// Overflow recovery: the captured request is the one that overflowed.
	if (reason === "overflow") return debug("overflow recovery");
	const tail = replayTail(branchEntries as never, captured);
	if (!tail) return debug("branch moved past the captured request");

	const tailText = serializeConversation(convertToLlm(tail as never));
	const prompt = replayPrompt({ previousSummary: preparation.previousSummary, customInstructions });
	// ~3 characters per token is a deliberately high estimate for the appended text.
	const room = summaryRoom(model.contextWindow, preparation.tokensBefore + Math.ceil((tailText.length + prompt.length) / 3));
	if (room === undefined) return debug(`too little room for a summary (${preparation.tokensBefore} of ${model.contextWindow})`);

	const payload = buildReplayPayload(captured, tailText, prompt, room);

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			// Placeholder: onPayload swaps in the replayed request wholesale.
			{ messages: [{ role: "user", content: [{ type: "text", text: "." }], timestamp: Date.now() }] },
			{ onPayload: () => payload, sessionId: ctx.sessionManager.getSessionId(), signal } as never,
		);
		if (signal.aborted) return;
		if (response.stopReason !== "stop") return debug(`replay stopped: ${response.stopReason} ${response.errorMessage ?? ""}`);
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const start = text.indexOf("## Goal");
		if (start < 0) return debug("replay gave no summary");
		const summary = text.slice(start).trim();
		debug(`replay ok: cacheRead=${response.usage?.cacheRead} cacheWrite=${response.usage?.cacheWrite} input=${response.usage?.input} output=${response.usage?.output}`);
		ctx.ui.notify(
			`Compacted from the prompt cache (${(response.usage?.cacheRead ?? 0).toLocaleString()} tokens read from cache)`,
			"info",
		);

		const lists = fileLists(preparation.fileOps);
		return {
			compaction: {
				summary: appendFileLists(summary, lists),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: response.usage,
				details: { ...lists, cacheReplay: true },
			},
		};
	} catch (error) {
		return debug(`replay threw: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Append a line to $PI_COMPACTION_DEBUG, if set. Returns undefined for `return debug(...)`. */
function debug(line: string): undefined {
	const file = process.env.PI_COMPACTION_DEBUG;
	if (file) appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	return undefined;
}
