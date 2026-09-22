import { uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Compaction without the high-effort thinking tax.
//
// pi budgets the summary call at `Math.min(0.8 * reserveTokens, model.maxTokens)`
// -- 13,107 tokens with the default 16,384 reserve. It then passes the *session*
// thinking level into that call, and GitHub Copilot's Claude Opus 5.x models
// use `compat.forceAdaptiveThinking`, so at xhigh the model can spend the whole
// 13k budget reasoning before it writes a single line of summary. The response
// comes back `stopReason: "length"`, and since pi 0.83 a truncated summary is
// refused rather than persisted:
//
//   if (response.stopReason === "length")
//     return `${label} failed: generation hit the token cap ...`
//
// retryAssistantCall() only retries `stopReason: "error"`, so "length" is never
// retried. Compaction throws, context stays above the threshold, the next turn
// tries again, and the session wedges.
//
// Measured over 229 saved compactions in ~/.pi/agent/sessions, summary *text*
// alone hit p90 11,821 / p99 15,263 / max 17,690 tokens -- 10 of them already
// exceeded 13,107 with no reasoning at all. So this handler does two things:
//
//   1. Summarizes on the same model with thinking disabled where supported.
//      Opus 5.5 requires adaptive thinking, so it gets low effort instead.
//   2. Gives thinking + summary a 64k ceiling instead of 0.8 * reserveTokens.
//
// It also strips assistant reasoning out of the text being summarized. In the
// worst session measured, `[Assistant thinking]` blocks were 60.6% of the
// serialization (115k of 190k tokens) -- they are the model's scratch work, not
// checkpoint material, and dropping them keeps the request far away from
// clampMaxTokensToContext() squeezing max_tokens toward zero.

/** Shared ceiling for adaptive thinking plus summary text. Only emitted tokens are billed. */
const MAX_SUMMARY_TOKENS = 64_000;

/** Keep a little reasoning for signal; discard the other 99%. */
const THINKING_CHARS = 400;

const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const FORMAT = `Use this EXACT format:

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

const UPDATE_RULES = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- MOVE items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages`;

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const model = ctx.model;

		// `thinkingEnabled` is an anthropic-messages stream option. For any other
		// API, returning undefined hands control back to pi's default compaction.
		if (!model || model.api !== "anthropic-messages") return;

		// `off: null` marks models that reject `thinking: {type: "disabled"}`.
		// Opus 5.5 is handled explicitly below with low-effort adaptive thinking;
		// leave other thinking-only models to pi's default compaction.
		const useLowAdaptiveThinking = model.id === "claude-opus-5.5";
		if (model.thinkingLevelMap?.off === null && !useLowAdaptiveThinking) return;

		const { messagesToSummarize, turnPrefixMessages, previousSummary, tokensBefore, firstKeptEntryId, fileOps } =
			preparation;

		const messages = convertToLlm([...messagesToSummarize, ...turnPrefixMessages]).map((msg) => {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
			return {
				...msg,
				content: msg.content.map((block) =>
					block.type === "thinking" && block.thinking.length > THINKING_CHARS
						? { ...block, thinking: `${block.thinking.slice(0, THINKING_CHARS)} […]` }
						: block,
				),
			};
		});

		const conversation = serializeConversation(messages);
		if (!conversation.trim()) return;

		const prompt = [
			`<conversation>\n${conversation}\n</conversation>`,
			previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${UPDATE_RULES}` : "",
			FORMAT,
		]
			.filter(Boolean)
			.join("\n\n");

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				},
				{
					// Opus 5.5 rejects disabled thinking with HTTP 400. Keep its required
					// adaptive thinking at low effort; disable thinking on models that allow it.
					...(useLowAdaptiveThinking
						? { thinkingEnabled: true, effort: "low" }
						: { thinkingEnabled: false }),
					maxTokens: MAX_SUMMARY_TOKENS,
					// One-off prompt, never reused: do not pay for a cache write.
					cacheRetention: "none",
					sessionId: uuidv7(),
					signal,
				} as never,
			);

			if (signal.aborted) return;

			if (response.stopReason === "length" || response.stopReason === "error") {
				// Falling through to pi's default compaction here would just fail the
				// same way with a smaller budget, so say so loudly instead.
				ctx.ui.notify(
					`thoughtless-compaction: summary ${response.stopReason} at ${MAX_SUMMARY_TOKENS.toLocaleString()} tokens`,
					"error",
				);
				return;
			}

			let summary = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (!summary.trim()) return;

			// Mirror pi's own file tracking so the lists keep accumulating across
			// successive compactions instead of resetting on the first custom one.
			const modifiedFiles = [...new Set([...fileOps.edited, ...fileOps.written])].sort();
			const readFiles = [...fileOps.read].filter((f) => !modifiedFiles.includes(f)).sort();
			if (readFiles.length > 0) summary += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
			if (modifiedFiles.length > 0) summary += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			if (signal.aborted) return;
			ctx.ui.notify(
				`thoughtless-compaction: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	});
}
