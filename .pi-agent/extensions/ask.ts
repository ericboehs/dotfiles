/**
 * ask — minimal AskUserQuestion for pi.
 *
 * Single question, options list, mouse + keyboard. Keeps boot fast and
 * per-turn tokens low: one small tool, no session_start work, no npm deps.
 *
 * - `multiSelect: true` allows multiple picks on one question.
 * - `questions: [...]` asks several questions sequentially in one call.
 *   Batch mode shows `Qn/total` progress; `shift+tab`/`←` or clicking the
 *   `← Back` row steps back to the previous question with prior picks
 *   preserved (`esc` still cancels).
 *
 * Both modes render their own wrapped rows (SelectList truncates long
 * labels/descriptions instead of wrapping) and hit-test clicks zone-style
 * (same idea as next-steps.ts chips). Fullscreen TUI only — regular mode
 * falls back to keyboard, RPC falls back to select/input dialogs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	Text,
	type SelectItem,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_VALUE = "__custom__";

/** Returned from batch pickers when the user steps back a question (TUI-only). Exported for tests. */
export const BACK = Symbol("back");

/** Click zone index for the `← Back` row; option zones use 0..n. */
const BACK_ZONE = -1;

/** Map a previous answer label back to its item value. Pure for tests. */
export function initialSingleValue(options: AskOption[], prevAnswers: string[]): string | undefined {
	const first = prevAnswers[0];
	if (!first) return undefined;
	const idx = options.findIndex((o) => o.label === first);
	return idx >= 0 ? String(idx) : undefined;
}

/** Map previous answer labels back to item values, skipping stale labels. Pure for tests. */
export function initialMultiValues(options: AskOption[], prevAnswers: string[]): string[] {
	const values: string[] = [];
	for (const a of prevAnswers) {
		const idx = options.findIndex((o) => o.label === a);
		if (idx >= 0) values.push(String(idx));
	}
	return values;
}

export interface AskOption {
	label: string;
	description?: string;
}

/** Numbered display items plus the trailing custom row. Pure for tests. */
export function buildItems(options: AskOption[]): SelectItem[] {
	const list: SelectItem[] = options.map((o, i) => ({
		value: String(i),
		label: `${i + 1}. ${o.label}`,
		description: o.description,
	}));
	list.push({ value: CUSTOM_VALUE, label: `${list.length + 1}. Type something.` });
	return list;
}

/**
 * Comma/space-separated 1-based picks to deduped numbers, first-seen order.
 * Garbage tokens are skipped, so "1, 2," still parses; [] means none valid.
 */
export function parseMultiPicks(raw: string, count: number): number[] {
	const picks: number[] = [];
	for (const part of raw.split(/[, ]+/)) {
		if (part === "") continue;
		const n = Number(part);
		if (!Number.isInteger(n) || n < 1 || n > count) continue;
		if (!picks.includes(n)) picks.push(n);
	}
	return picks;
}

/**
 * Append `text` to `lines`, word-wrapped to width `w`. The first line gets
 * `prefix` (may contain ANSI); continuations are indented to its visible
 * width. Handles the ANSI-unsafe case where the prefix alone fills the line.
 */
function pushWrapped(lines: string[], prefix: string, text: string, w: number): void {
	const pw = visibleWidth(prefix);
	if (pw >= w) {
		lines.push(...wrapTextWithAnsi(prefix + text, w));
		return;
	}
	const wrapped = wrapTextWithAnsi(text, w - pw);
	const cont = " ".repeat(pw);
	for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
}

/** RPC select() takes bare strings, so fold the description in. Pure for tests. */
export function formatRpcLabel(label: string, description?: string): string {
	return description ? `${label} — ${description}` : label;
}

/** "User selected: …" plus "User wrote: …" lines. Pure for tests. */
export function formatAnswerLines(labels: string[], answers: string[], custom: string[]): string[] {
	const picked = answers.map((a) => `${labels.indexOf(a) + 1}. ${a}`).join(", ");
	const lines = [`User selected: ${picked}`];
	for (const c of custom) lines.push(`User wrote: ${c}`);
	return lines;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Option label" }),
	description: Type.Optional(Type.String({ description: "One-line detail" })),
});

const BatchQuestionSchema = Type.Object({
	question: Type.String({ description: "Question to ask" }),
	options: Type.Array(OptionSchema, { description: "2-4 options" }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple picks" })),
});

const AskParams = Type.Object({
	question: Type.Optional(Type.String({ description: "Question to ask" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "2-4 options" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple picks" })),
	questions: Type.Optional(Type.Array(BatchQuestionSchema, { description: "Ask several questions at once" })),
});

interface SubQuestion {
	question: string;
	options: AskOption[];
	multiSelect?: boolean;
}

interface QuestionResult {
	question: string;
	options: string[];
	answers: string[];
	custom: string[];
}

interface AskDetails {
	question: string;
	options: string[];
	answers: string[];
	custom: string[];
	cancelled: boolean;
	byQuestion?: QuestionResult[];
}

function cancelled(question: string, options: string[]): { content: { type: "text"; text: string }[]; details: AskDetails } {
	return {
		content: [{ type: "text", text: "User cancelled" }],
		details: { question, options, answers: [], custom: [], cancelled: true },
	};
}

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user questions with options. multiSelect allows multiple picks; questions[] asks several at once. Use when ambiguous or multiple valid answers.",
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_id, params, _signal, _onUpdate, ctx) {
			let subs: SubQuestion[];
			if (params.questions && params.questions.length > 0) {
				subs = params.questions;
			} else if (params.question && params.options) {
				subs = [{ question: params.question, options: params.options, multiSelect: params.multiSelect }];
			} else {
				return {
					content: [{ type: "text", text: "Error: provide question+options or questions[]" }],
					details: { question: "", options: [], answers: [], custom: [], cancelled: true } as AskDetails,
				};
			}
			for (const sub of subs) {
				if (!sub.options || sub.options.length === 0) {
					return {
						content: [{ type: "text", text: `Error: no options provided for "${sub.question}"` }],
						details: { question: sub.question, options: [], answers: [], custom: [], cancelled: true } as AskDetails,
					};
				}
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI unavailable (non-interactive mode)" }],
					details: { question: "", options: [], answers: [], custom: [], cancelled: true } as AskDetails,
				};
			}

			/** Split picked item-values into option answers + optional free text. Null = nothing left. */
			const resolveCustom = async (
				options: SubQuestion["options"],
				values: string[],
			): Promise<{ answers: string[]; custom: string[] } | null> => {
				const answers: string[] = [];
				let wantCustom = false;
				for (const v of values) {
					if (v === CUSTOM_VALUE) wantCustom = true;
					else {
						const label = options[Number(v)]?.label;
						if (label !== undefined) answers.push(label);
					}
				}
				const custom: string[] = [];
				if (wantCustom) {
					const text = await ctx.ui.input("Custom answer:");
					if (text) custom.push(text);
				}
				if (answers.length === 0 && custom.length === 0) return null;
				return { answers, custom };
			};

			const pickSingle = async (
				question: string,
				items: SelectItem[],
				nav?: { canGoBack?: boolean; progress?: string; initialValue?: string },
			): Promise<string | typeof BACK | undefined> => {
				if (ctx.mode === "tui") {
					// Custom renderer instead of SelectList: SelectList truncates
					// long labels/descriptions to one line; this wraps them.
					return ctx.ui.custom<string | typeof BACK | undefined>((tui, theme, _kb, done) => {
						let cursor = (() => {
							if (nav?.initialValue === undefined) return 0;
							const found = items.findIndex((i) => i.value === nav.initialValue);
							return found >= 0 ? found : 0;
						})();
						let cached: string[] | undefined;
						let zones: Array<{ index: number; start: number; end: number }> = [];

						const refresh = () => {
							cached = undefined;
							tui.requestRender();
						};
						const pick = (i: number) => done(items[i]!.value);

						function handleInput(data: string) {
							if (nav?.canGoBack && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
								done(BACK);
								return;
							}
							if (matchesKey(data, Key.up)) {
								cursor = (cursor - 1 + items.length) % items.length;
								refresh();
								return;
							}
							if (matchesKey(data, Key.down)) {
								cursor = (cursor + 1) % items.length;
								refresh();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								pick(cursor);
								return;
							}
							if (matchesKey(data, Key.escape)) {
								done(undefined);
								return;
							}
							if (data.length === 1 && data >= "1" && data <= "9") {
								const idx = Number(data) - 1;
								if (idx < items.length) pick(idx);
							}
						}

						function render(width: number): string[] {
							if (cached) return cached;
							const w = Math.max(1, width);
							zones = [];
							const lines: string[] = [];
							lines.push(theme.fg("accent", "─".repeat(w)));
							if (nav?.progress) pushWrapped(lines, " ", theme.fg("dim", nav.progress), w);
							pushWrapped(lines, " ", theme.fg("text", question), w);
							lines.push("");
							items.forEach((item, i) => {
								const start = lines.length;
								const mark = i === cursor ? theme.fg("accent", "→ ") : "  ";
								const color = i === cursor ? "accent" : "text";
								pushWrapped(lines, mark, theme.fg(color, item.label), w);
								if (item.description) pushWrapped(lines, "     ", theme.fg("muted", item.description), w);
								zones.push({ index: i, start, end: lines.length });
							});
							if (nav?.canGoBack) {
								const backStart = lines.length;
								pushWrapped(lines, "  ", theme.fg("dim", "← Back"), w);
								zones.push({ index: BACK_ZONE, start: backStart, end: lines.length });
							}
							lines.push("");
							const backHint = nav?.canGoBack ? " • shift+tab/← back" : "";
							pushWrapped(lines, " ", theme.fg("dim", `↑↓/click select • 1-9 quick pick • enter confirm • esc cancel${backHint}`), w);
							lines.push(theme.fg("accent", "─".repeat(w)));
							cached = lines;
							return lines;
						}

						return {
							render,
							invalidate: () => {
								cached = undefined;
							},
							handleInput,
							// Click selects immediately (matches SelectList's click = select + confirm).
							handleMouse: (event: any) => {
								if (event?.type !== "click" || event?.button !== "left") return undefined;
								const hit = zones.find((z) => event.y >= z.start && event.y < z.end);
								if (!hit) return undefined;
								if (hit.index === BACK_ZONE) {
									done(BACK);
									return { handled: true };
								}
								pick(hit.index);
								return { handled: true };
							},
						};
					});
				}
				// RPC: dialog protocol (custom() is TUI-only and returns undefined).
				const display = items.map((i) => formatRpcLabel(i.label, i.description));
				const picked = await ctx.ui.select(question, display);
				if (picked === undefined) return undefined;
				const idx = display.findIndex((d) => d === picked);
				return idx >= 0 ? items[idx]!.value : undefined;
			};

			const pickMulti = async (
				question: string,
				items: SelectItem[],
				nav?: { canGoBack?: boolean; progress?: string; initialValues?: string[] },
			): Promise<string[] | typeof BACK | null> => {
				if (ctx.mode === "tui") {
					const res = await ctx.ui.custom<{ values: string[] } | typeof BACK | null>((tui, theme, _kb, done) => {
						let cursor = (() => {
							if (!nav?.initialValues?.length) return 0;
							const found = items.findIndex((i) => i.value === nav.initialValues![0]);
							return found >= 0 ? found : 0;
						})();
						const checked = new Set<number>((() => {
							if (!nav?.initialValues) return [];
							const idxs: number[] = [];
							for (const v of nav.initialValues) {
								const found = items.findIndex((i) => i.value === v);
								if (found >= 0) idxs.push(found);
							}
							return idxs;
						})());
						let hint: string | null = null;
						let cached: string[] | undefined;
						let zones: Array<{ index: number; start: number; end: number }> = [];

						const refresh = () => {
							cached = undefined;
							tui.requestRender();
						};
						const toggle = (i: number) => {
							if (checked.has(i)) checked.delete(i);
							else checked.add(i);
							hint = null;
							refresh();
						};
						const submit = () => {
							if (checked.size === 0) {
								hint = "Select at least one option (space/click), or Esc to cancel";
								refresh();
								return;
							}
							done({ values: [...checked].sort((a, b) => a - b).map((i) => items[i]!.value) });
						};

						function handleInput(data: string) {
							if (nav?.canGoBack && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
								done(BACK);
								return;
							}
							if (matchesKey(data, Key.up)) {
								cursor = (cursor - 1 + items.length) % items.length;
								hint = null;
								refresh();
								return;
							}
							if (matchesKey(data, Key.down)) {
								cursor = (cursor + 1) % items.length;
								hint = null;
								refresh();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								submit();
								return;
							}
							if (matchesKey(data, Key.escape)) {
								done(null);
								return;
							}
							if (matchesKey(data, Key.space)) {
								toggle(cursor);
								return;
							}
							if (data.length === 1 && data >= "1" && data <= "9") {
								const idx = Number(data) - 1;
								if (idx < items.length) toggle(idx);
								return;
							}
							if (data === "a") {
								if (checked.size === items.length) checked.clear();
								else items.forEach((_, i) => checked.add(i));
								hint = null;
								refresh();
							}
						}

						function render(width: number): string[] {
							if (cached) return cached;
							const w = Math.max(1, width);
							zones = [];
							const lines: string[] = [];
							lines.push(theme.fg("accent", "─".repeat(w)));
							if (nav?.progress) pushWrapped(lines, " ", theme.fg("dim", nav.progress), w);
							pushWrapped(lines, " ", theme.fg("text", question), w);
							lines.push("");
							items.forEach((item, i) => {
								const start = lines.length;
								const box = checked.has(i) ? "[x]" : "[ ]";
								const mark = i === cursor ? theme.fg("accent", "> ") : "  ";
								const color = i === cursor ? "accent" : "text";
								pushWrapped(lines, mark, `${theme.fg(color, box)} ${theme.fg(color, item.label)}`, w);
								if (item.description) pushWrapped(lines, "      ", theme.fg("muted", item.description), w);
								zones.push({ index: i, start, end: lines.length });
							});
							if (nav?.canGoBack) {
								const backStart = lines.length;
								pushWrapped(lines, "  ", theme.fg("dim", "← Back"), w);
								zones.push({ index: BACK_ZONE, start: backStart, end: lines.length });
							}
							lines.push("");
							if (hint) pushWrapped(lines, " ", theme.fg("warning", hint), w);
							else {
								const sel = checked.size > 0 ? ` • ${checked.size} selected` : "";
								const backHint = nav?.canGoBack ? " • shift+tab/← back" : "";
								pushWrapped(lines, " ", theme.fg("dim", `↑↓ move • space/click toggle • a all • enter done${sel} • esc cancel${backHint}`), w);
							}
							lines.push(theme.fg("accent", "─".repeat(w)));
							cached = lines;
							return lines;
						}

						return {
							render,
							invalidate: () => {
								cached = undefined;
							},
							handleInput,
							// Click-only toggle so transcript drag-select keeps working.
							handleMouse: (event: any) => {
								if (event?.type !== "click" || event?.button !== "left") return undefined;
								const hit = zones.find((z) => event.y >= z.start && event.y < z.end);
								if (!hit) return undefined;
								if (hit.index === BACK_ZONE) {
									done(BACK);
									return { handled: true };
								}
								toggle(hit.index);
								return { handled: true };
							},
						};
					});
					if (res === BACK) return BACK;
					if (res === null || res === undefined) return null;
					return res.values;
				}
				// RPC: one input round-trip, comma-separated numbers.
				const raw = await ctx.ui.input(question, "e.g. 1,3");
				if (!raw) return null;
				const picks = parseMultiPicks(raw, items.length);
				if (picks.length === 0) return null;
				return picks.map((n) => items[n - 1]!.value);
			};


			// ---------- single question (unchanged behavior) ----------
			if (subs.length === 1) {
				const sub = subs[0]!;
				const labels = sub.options.map((o) => o.label);
				const items = buildItems(sub.options);
				const values = sub.multiSelect ? await pickMulti(sub.question, items) : [await pickSingle(sub.question, items)];
				if (values === null || values[0] === undefined) return cancelled(sub.question, labels);
				const resolved = await resolveCustom(sub.options, values as string[]);
				if (resolved === null) return cancelled(sub.question, labels);
				if (!sub.multiSelect && resolved.custom.length > 0) {
					return {
						content: [{ type: "text", text: `User wrote: ${resolved.custom[0]}` }],
						details: { question: sub.question, options: labels, answers: [], custom: resolved.custom, cancelled: false } as AskDetails,
					};
				}
				return {
					content: [{ type: "text", text: formatAnswerLines(labels, resolved.answers, resolved.custom).join("\n") }],
					details: { question: sub.question, options: labels, answers: resolved.answers, custom: resolved.custom, cancelled: false } as AskDetails,
				};
			}

			// ---------- batch: several questions, one call ----------
			// Index loop (not for..of) so shift+tab/← can step back.
			// Later answers are kept for pre-fill but excluded from cancel
			// output via slice(0, i); re-answering overwrites by index.
			// Custom free text can't pre-fill ctx.ui.input, so revisiting a
			// question with a previous custom answer re-prompts for it.
			const answered: (QuestionResult | undefined)[] = new Array(subs.length);
			const answeredPrefix = (end: number): QuestionResult[] =>
				answered.slice(0, end).filter((q): q is QuestionResult => q !== undefined);
			const cancelBatch = (end: number) => {
				const prefix = answeredPrefix(end);
				return {
					content: [{ type: "text", text: [...prefix.flatMap((q, i) => [`Q${i + 1}: ${q.question}`, ...formatAnswerLines(q.options, q.answers, q.custom)]), "User cancelled (remaining questions skipped)"].join("\n") }],
					details: { question: `${subs.length} questions`, options: [], answers: [], custom: [], cancelled: true, byQuestion: prefix } as AskDetails,
				};
			};
			let i = 0;
			while (i < subs.length) {
				const sub = subs[i]!;
				const progress = `Q${i + 1}/${subs.length}`;
				const labels = sub.options.map((o) => o.label);
				const items = buildItems(sub.options);
				const prev = answered[i];
				const nav = { canGoBack: i > 0, progress };
				let values: string[];
				if (sub.multiSelect) {
					const initialValues = prev ? initialMultiValues(sub.options, prev.answers) : undefined;
					const picked = await pickMulti(sub.question, items, { ...nav, initialValues });
					if (picked === BACK) {
						i--;
						continue;
					}
					if (picked === null) return cancelBatch(i);
					values = picked;
				} else {
					const initialValue = prev ? initialSingleValue(sub.options, prev.answers) : undefined;
					const picked = await pickSingle(sub.question, items, { ...nav, initialValue });
					if (picked === BACK) {
						i--;
						continue;
					}
					if (picked === undefined) return cancelBatch(i);
					values = [picked];
				}
				const resolved = await resolveCustom(sub.options, values);
				if (resolved === null) return cancelBatch(i);
				answered[i] = { question: sub.question, options: labels, answers: resolved.answers, custom: resolved.custom };
				i++;
			}
			const byQuestion = answered as QuestionResult[];
			return {
				content: [{ type: "text", text: byQuestion.flatMap((q, i) => [`Q${i + 1}: ${q.question}`, ...formatAnswerLines(q.options, q.answers, q.custom)]).join("\n") }],
				details: {
					question: `${subs.length} questions`,
					options: [],
					answers: byQuestion.flatMap((q) => q.answers),
					custom: byQuestion.flatMap((q) => q.custom),
					cancelled: false,
					byQuestion,
				} as AskDetails,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args as any).questions as Array<{ question: string }> | undefined;
			if (qs?.length) {
				return new Text(
					theme.fg("toolTitle", theme.bold("ask (batch) ")) + theme.fg("muted", `${qs.length} questions`),
					0,
					0,
				);
			}
			const opts = (Array.isArray((args as any).options) ? (args as any).options : []) as Array<{ label: string }>;
			let text = theme.fg("toolTitle", theme.bold((args as any).multiSelect ? "ask (multi) " : "ask "));
			text += theme.fg("muted", String((args as any).question ?? ""));
			if (opts.length) {
				text += `\n${theme.fg("dim", `  ${opts.map((o, i) => `${i + 1}. ${o.label}`).join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskDetails | undefined;
			const fallback = result.content[0];
			if (!details) return new Text(fallback?.type === "text" ? fallback.text : "", 0, 0);
			if (details.cancelled && !details.byQuestion?.length) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const section = (options: string[], answers: string[], custom: string[]): string[] => {
				const lines: string[] = [];
				for (const a of answers) {
					const idx = options.indexOf(a) + 1;
					lines.push(theme.fg("success", "✓ ") + theme.fg("accent", idx > 0 ? `${idx}. ${a}` : a));
				}
				for (const c of custom) {
					lines.push(theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", c));
				}
				return lines;
			};
			if (details.byQuestion) {
				const lines = details.byQuestion.flatMap((q, i) => [
					theme.fg("muted", `Q${i + 1}: ${q.question}`),
					...section(q.options, q.answers, q.custom),
				]);
				if (details.cancelled) lines.push(theme.fg("warning", "Cancelled (remaining skipped)"));
				return new Text(lines.join("\n"), 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			return new Text(section(details.options, details.answers, details.custom).join("\n"), 0, 0);
		},
	});
}
