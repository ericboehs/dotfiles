// Pure helpers for cache-reusing compaction and the idle timer. No pi imports,
// so the tests can load this file without a running session.
//
// The idea, borrowed from Claude Code: pi's default summarizer flattens the
// conversation to text under its own system prompt, so every compaction pays
// full input price for the whole history. Replaying the session's last real
// provider request -- same system prompt, same tools, same messages -- with a
// "summarize" turn appended keeps the cached prefix byte-identical, so the
// history is billed as a cache read (about 1/20th the input price on Claude).

/** Entry types that never reach the model, so they can trail the last reply. */
const INVISIBLE_ENTRY_TYPES = new Set(["custom", "label", "session_info", "usage", "thinking_level_change"]);

/** How long before expiry the idle timer fires: enough to summarize and persist. */
export const IDLE_LEAD_MS = 6 * 60_000;

/** Treat the cache as cold this long before its nominal expiry. */
export const WARM_MARGIN_MS = 30_000;

export interface CapturedRequest {
	payload: { messages: unknown[]; [key: string]: unknown };
	provider: string;
	modelId: string;
	/** Date.now() when the request was handed to the provider. The cache TTL counts from here. */
	at: number;
	/** The session's leaf entry when the request was sent: everything after it is new. */
	leafId: string | null;
}

interface Entry {
	id?: string;
	type: string;
	message?: { role?: string; content?: unknown; stopReason?: string; timestamp?: number };
}

/** Prompt-cache lifetime pi asks for: 1 hour with PI_CACHE_RETENTION=long, else Anthropic's 5 minutes. */
export function cacheTtlMs(env: Record<string, string | undefined> = process.env): number {
	return env.PI_CACHE_RETENTION === "long" ? 60 * 60_000 : 5 * 60_000;
}

/** A main-session Anthropic request: it carries the tool list. Summaries and titles do not. */
export function isSessionPayload(payload: unknown): payload is CapturedRequest["payload"] {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as { messages?: unknown; tools?: unknown };
	return Array.isArray(p.messages) && p.messages.length > 0 && Array.isArray(p.tools) && p.tools.length > 0;
}

export function cacheIsWarm(captured: CapturedRequest, now: number, ttlMs: number): boolean {
	return now - captured.at < ttlMs - WARM_MARGIN_MS;
}

/**
 * The messages added since `captured` was sent, if they are only the model's
 * own turns: its replies and tool results. Anything else (a queued user
 * message, a context edit, a model change, an errored or aborted reply) means
 * the captured payload plus a transcript of the tail would not tell the whole
 * story, so the caller falls back.
 */
export function replayTail<T extends Entry>(entries: T[], captured: CapturedRequest): T["message"][] | undefined {
	if (!captured.leafId) return undefined;
	const start = entries.findIndex((entry) => entry.id === captured.leafId);
	if (start < 0) return undefined;
	const tail: T["message"][] = [];
	for (const entry of entries.slice(start + 1)) {
		if (INVISIBLE_ENTRY_TYPES.has(entry.type)) continue;
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "toolResult") tail.push(message);
		else if (message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted")
			tail.push(message);
		else return undefined;
	}
	return tail.some((message) => message?.role === "assistant") ? tail : undefined;
}

/**
 * The captured payload plus one user message: a transcript of the turns since
 * (the reply and any tool results), then the summarize request. Everything
 * before the append is left byte-for-byte alone, cache_control markers
 * included, so the provider finds the prefix it cached. Anthropic merges the
 * new user message into a trailing tool_result turn, which does not touch the
 * cached blocks. Only max_tokens may shrink to fit the window; with adaptive
 * thinking it is not part of the cache key.
 */
export function buildReplayPayload(captured: CapturedRequest, tailText: string, prompt: string, maxTokens?: number) {
	const payload = structuredClone(captured.payload);
	const text = tailText ? `<latest-turns>\n${tailText}\n</latest-turns>\n\n${prompt}` : prompt;
	payload.messages.push({ role: "user", content: [{ type: "text", text }] });
	if (maxTokens !== undefined && typeof payload.max_tokens === "number" && maxTokens < payload.max_tokens)
		payload.max_tokens = maxTokens;
	return payload;
}

/** Below this much output room, a long summary could hit the cap; fall back instead. */
export const MIN_SUMMARY_ROOM = 32_000;

/** Output room left in the window after the replayed input, or undefined if too little. */
export function summaryRoom(contextWindow: number, inputTokens: number): number | undefined {
	const room = contextWindow - inputTokens - 1_024;
	return room >= MIN_SUMMARY_ROOM ? room : undefined;
}

/** Milliseconds until the idle compaction should fire, or undefined if it is already too late. */
export function idleDelayMs(captured: CapturedRequest, now: number, ttlMs: number, leadMs = IDLE_LEAD_MS) {
	const delay = captured.at + ttlMs - leadMs - now;
	return delay > 0 ? delay : undefined;
}

/** A footer-sized clock: 10:54p, 9:05a. */
export function clockLabel(date: Date): string {
	const hours = date.getHours();
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours % 12 || 12}:${minutes}${hours < 12 ? "a" : "p"}`;
}

/**
 * True when the context is at least `minTokens`, or `minPercent` of the
 * model's window if that is smaller. A fixed count suits 1M windows, where half
 * the window is 500K and would almost never arm; the share keeps 200K-256K
 * windows, which compact before reaching 200K, arming at half their size.
 */
export function contextIsLarge(
	usage: { tokens: number | null; contextWindow: number; percent?: number | null } | undefined,
	minPercent: number,
	minTokens = Number.POSITIVE_INFINITY,
): boolean {
	if (!usage || usage.tokens == null || !usage.contextWindow) return false;
	return usage.tokens >= armThreshold(usage.contextWindow, minPercent, minTokens);
}

/** PI_IDLE_COMPACT_MIN_TOKENS, a positive count, default 200,000. */
export function minTokens(env: Record<string, string | undefined> = process.env): number {
	const value = Number(env.PI_IDLE_COMPACT_MIN_TOKENS);
	return Number.isFinite(value) && value >= 1 ? value : 200_000;
}

/** The context size that arms the idle timer for a window. */
export function armThreshold(contextWindow: number, percent: number, tokens: number): number {
	return Math.min(tokens, (contextWindow * percent) / 100);
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

const minutesUntil = (at: number, now: number) => `${Math.max(0, Math.round((at - now) / 60_000))}m`;

/**
 * /idle: whether the idle timer is armed, or the first condition that keeps
 * it from arming, plus the numbers behind it.
 */
export function idleStatus(o: {
	env: Record<string, string | undefined>;
	api: string | undefined;
	usage: { tokens: number | null; contextWindow: number } | undefined;
	captured: CapturedRequest | undefined;
	firesAt: number | undefined;
	now: number;
}): string {
	const { env, api, usage, captured, firesAt, now } = o;
	const ttl = cacheTtlMs(env);
	const threshold = usage?.contextWindow ? armThreshold(usage.contextWindow, minPercent(env), minTokens(env)) : undefined;
	const details = [
		usage?.tokens != null && threshold !== undefined ? `context ${kTokens(usage.tokens)}, threshold ${kTokens(threshold)}` : undefined,
		captured ? `last request ${clockLabel(new Date(captured.at))}, cache warm until ${clockLabel(new Date(captured.at + ttl))}` : undefined,
	]
		.filter(Boolean)
		.join("; ");
	const line = (headline: string) => (details ? `${headline}\n${details}` : headline);

	if (firesAt !== undefined) return line(`Armed: compacts at ${clockLabel(new Date(firesAt))} (in ${minutesUntil(firesAt, now)}) unless you type first.`);
	if (env.PI_CACHE_RETENTION !== "long")
		return line("Off: PI_CACHE_RETENTION is not long in this pi's environment. Restart pi from a fresh shell.");
	if (env.PI_IDLE_COMPACT === "0") return line("Off: PI_IDLE_COMPACT=0.");
	if (api !== "anthropic-messages") return line(`Not armed: this model uses ${api ?? "no"} API, not anthropic-messages.`);
	if (!captured) return line("Not armed: no request since this session started or reloaded. It arms after the next reply.");
	if (usage?.tokens == null || threshold === undefined) return line("Not armed: context size unknown until the next reply.");
	if (usage.tokens < threshold) return line(`Not armed: context is below the ${kTokens(threshold)} threshold.`);
	if (idleDelayMs(captured, now, ttl) === undefined) return line("Not armed: too close to the cache expiring to compact from it.");
	return line("Not armed yet: it arms when the current turn finishes.");
}

/** PI_IDLE_COMPACT_MIN_PERCENT, clamped to 1..100, default 50. */
export function minPercent(env: Record<string, string | undefined> = process.env): number {
	const value = Number(env.PI_IDLE_COMPACT_MIN_PERCENT);
	return Number.isFinite(value) && value >= 1 && value <= 100 ? value : 50;
}

/** Idle compaction runs only with the 1-hour cache, and PI_IDLE_COMPACT=0 turns it off. */
export function idleCompactEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.PI_CACHE_RETENTION === "long" && env.PI_IDLE_COMPACT !== "0";
}

export const SUMMARY_FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Constraints, preferences, or requirements the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, examples, or references needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** The summarize turn appended to the replayed conversation. */
export function replayPrompt(options: { previousSummary?: string; customInstructions?: string } = {}): string {
	return [
		"[Context checkpoint] Pause the task. Do not call any tools and do not continue the work.",
		"The older part of this conversation is about to be replaced by a summary. Write that summary now, covering the whole conversation above, including any <latest-turns> transcript (your most recent turns, flattened to text). The most recent messages will stay verbatim after the summary, so put the detail into older work, decisions and constraints.",
		options.previousSummary
			? "The conversation already opens with an earlier summary. PRESERVE everything in it, ADD new progress and decisions, MOVE finished items from In Progress to Done, and UPDATE Next Steps."
			: "",
		options.customInstructions ? `Focus: ${options.customInstructions}` : "",
		"Output ONLY the summary, starting with \"## Goal\".",
		SUMMARY_FORMAT,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** pi's cumulative file lists: read-only files, and files written or edited. */
export function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
	const modifiedFiles = [...new Set([...fileOps.edited, ...fileOps.written])].sort();
	const readFiles = [...fileOps.read].filter((file) => !modifiedFiles.includes(file)).sort();
	return { readFiles, modifiedFiles };
}

export function appendFileLists(summary: string, lists: { readFiles: string[]; modifiedFiles: string[] }): string {
	let out = summary;
	if (lists.readFiles.length > 0) out += `\n\n<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`;
	if (lists.modifiedFiles.length > 0) out += `\n\n<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`;
	return out;
}
