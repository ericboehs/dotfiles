/**
 * ask — minimal AskUserQuestion for pi.
 *
 * Single question, options list, mouse + keyboard. Keeps boot fast and
 * per-turn tokens low: one small tool, no session_start work, no npm deps.
 *
 * - `multiSelect: true` allows multiple picks on one question.
 * - `questions: [...]` asks several questions sequentially in one call.
 *
 * Mouse: single mode uses SelectList (built-in press/click/wheel). Multi
 * mode renders its own checkbox rows and hit-tests clicks zone-style (same
 * idea as next-steps.ts chips). Fullscreen TUI only — regular mode falls
 * back to keyboard, RPC falls back to select/input dialogs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	Text,
	type SelectItem,
	SelectList,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_VALUE = "__custom__";

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

			const pickSingle = async (question: string, items: SelectItem[]): Promise<string | undefined> => {
				if (ctx.mode === "tui") {
					return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
						const container = new Container();
						const topBorder = new Text("", 0, 0);
						container.addChild(topBorder);
						container.addChild(new Text(theme.fg("text", question), 1, 0));
						container.addChild(new Text("", 0, 0));

						const list = new SelectList(items, Math.min(items.length, 10), {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						});
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done(undefined);
						container.addChild(list);
						container.addChild(new Text("", 0, 0));
						container.addChild(
							new Text(theme.fg("dim", "↑↓/click select • 1-9 quick pick • enter confirm • esc cancel"), 1, 0),
						);

						return {
							render: (w) => {
								const width = Math.max(1, w);
								topBorder.setText(theme.fg("accent", "─".repeat(width)));
								const lines = container.render(width);
								lines.push(theme.fg("accent", "─".repeat(width)));
								return lines;
							},
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								// Single-digit quick pick (SelectList doesn't bind numbers).
								if (data.length === 1 && data >= "1" && data <= "9") {
									const idx = Number(data) - 1;
									const item = items[idx];
									if (item) {
										done(item.value);
										return;
									}
								}
								list.handleInput(data);
								tui.requestRender();
							},
							// Forward clicks/wheel to Container → SelectList.
							// Click-only would preserve drag-select, but this modal
							// replaces the editor so press-to-highlight is fine.
							handleMouse: (event: any) => container.handleMouse(event),
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

			const pickMulti = async (question: string, items: SelectItem[]): Promise<string[] | null> => {
				if (ctx.mode === "tui") {
					const res = await ctx.ui.custom<{ values: string[] } | null>((tui, theme, _kb, done) => {
						let cursor = 0;
						const checked = new Set<number>();
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
							const addWrapped = (t: string) => {
								lines.push(...wrapTextWithAnsi(t, w));
							};
							const addPrefixed = (prefix: string, t: string) => {
								const pw = visibleWidth(prefix);
								if (pw >= w) {
									addWrapped(prefix + t);
									return;
								}
								const wrapped = wrapTextWithAnsi(t, w - pw);
								const cont = " ".repeat(pw);
								for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
							};

							lines.push(theme.fg("accent", "─".repeat(w)));
							addPrefixed(" ", theme.fg("text", question));
							lines.push("");
							items.forEach((item, i) => {
								const start = lines.length;
								const box = checked.has(i) ? "[x]" : "[ ]";
								const mark = i === cursor ? theme.fg("accent", "> ") : "  ";
								const color = i === cursor ? "accent" : "text";
								addPrefixed(mark, `${theme.fg(color, box)} ${theme.fg(color, item.label)}`);
								if (item.description) addPrefixed("      ", theme.fg("muted", item.description));
								zones.push({ index: i, start, end: lines.length });
							});
							lines.push("");
							if (hint) addPrefixed(" ", theme.fg("warning", hint));
							else {
								const sel = checked.size > 0 ? ` • ${checked.size} selected` : "";
								addPrefixed(" ", theme.fg("dim", `↑↓ move • space/click toggle • a all • enter done${sel} • esc cancel`));
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
								toggle(hit.index);
								return { handled: true };
							},
						};
					});
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
			const byQuestion: QuestionResult[] = [];
			for (const sub of subs) {
				const labels = sub.options.map((o) => o.label);
				const items = buildItems(sub.options);
				const values = sub.multiSelect ? await pickMulti(sub.question, items) : [await pickSingle(sub.question, items)];
				if (values === null || values[0] === undefined) {
					return {
						content: [{ type: "text", text: [...byQuestion.flatMap((q, i) => [`Q${i + 1}: ${q.question}`, ...formatAnswerLines(q.options, q.answers, q.custom)]), "User cancelled (remaining questions skipped)"].join("\n") }],
						details: { question: `${subs.length} questions`, options: [], answers: [], custom: [], cancelled: true, byQuestion } as AskDetails,
					};
				}
				const resolved = await resolveCustom(sub.options, values as string[]);
				if (resolved === null) {
					return {
						content: [{ type: "text", text: [...byQuestion.flatMap((q, i) => [`Q${i + 1}: ${q.question}`, ...formatAnswerLines(q.options, q.answers, q.custom)]), "User cancelled (remaining questions skipped)"].join("\n") }],
						details: { question: `${subs.length} questions`, options: [], answers: [], custom: [], cancelled: true, byQuestion } as AskDetails,
					};
				}
				byQuestion.push({ question: sub.question, options: labels, answers: resolved.answers, custom: resolved.custom });
			}
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
