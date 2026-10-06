/**
 * meeting.ts — live meeting copilot.
 *
 *   /meeting start [filter|path] [--wake] [--model provider/id] [--replay [speed]]
 *   /meeting ask            check right now
 *   /meeting focus <text>   what you want out of this meeting (fed to the scout)
 *   /meeting list           every question in the widget (again to collapse)
 *   /meeting recap          post the recap so far and update the daily note
 *   /meeting stop
 *   /meeting                status
 *   /q3 [what to look for]  research Q3 with a subagent (/q 3, or /q to pick)
 *
 * Tails the live meeting-capture transcript (~/.local/share/meeting-capture/
 * *.jsonl, finished caption lines only) and, when enough new talk has piled up,
 * asks a small fast model — DeepSeek V4.1 Flash on the Opencode Go subscription
 * by default — for questions worth asking out loud. No model is polled on a
 * timer: the file is, and code decides when a check is worth a call.
 *
 * Triggers: your name said by someone else, or "any questions?", fire after a
 * short pause; otherwise ~6 new lines plus a pause, 45s of unchecked talk, or a
 * flood of lines regardless, and never more than one check per 15s.
 *
 * Output:
 *   widget above the editor   the 3 open questions most worth asking now (new
 *                             ones show at once; the scout's re-ranking only
 *                             swaps one out after 3 min on screen) and a
 *                             suggested reply when someone is waiting on you
 *   session messages          a short custom message whenever a question is
 *                             added or a reply suggested, sent with
 *                             triggerTurn:false — it lands in the transcript and
 *                             the main model's context without starting a turn,
 *                             so the big model only runs when you ask it to
 *   --wake                    the one exception: when you're named and the scout
 *                             has a reply, wake the main model to draft an answer
 *   recap                     at the end, every question as still open, answered
 *                             or asked: posted to the session and upserted as a
 *                             ### block at the end of "## Meetings" in the daily
 *                             note for the capture's date (never for a replay)
 *   research                  /q3 runs a separate `pi -p` on the session model
 *                             (read-only tools, 3 min cap, at most 2 at once):
 *                             the brief lands as a session message, the answer
 *                             line in the widget and the recap. It works after
 *                             the meeting too, and then rewrites the recap.
 *
 * Questions only leave the list when the scout sees them answered or asked;
 * the rest stay open and drop out of the compact view, not the list.
 *
 * When the recorder writes "stopped", the copilot waits 90s (with a countdown)
 * for a reconnect, which starts a new capture file, before it stops.
 *
 * Scout context: a fixed system prompt (cached) with ~/.pi/agent/meeting-context.md
 * (who you are), the tail of the previous transcript of the same meeting, and
 * `qmd search` hits for the meeting title; then the transcript so far.
 *
 * Teams writes a caption only when it scrolls out of its ~3-line window, so the
 * transcript trails the room by a couple of utterances.
 *
 * Env: PI_MEETING_MODEL=provider/id[,provider/id…]  PI_MEETING_REASONING=off|low|…
 *      PI_MEETING_ME="First Last"  PI_MEETING_DIR  PI_MEETING_ABOUT=<file>
 *      PI_MEETING_QMD_COLLECTIONS=wiki,va-eert ("" disables)
 *      PI_MEETING_DAILY_DIR=~/Documents/Wiki/daily ("" disables the daily-note recap)
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ── config ───────────────────────────────────────────────────────────────────

const DIR = process.env.PI_MEETING_DIR || path.join(os.homedir(), ".local/share/meeting-capture");
/** Flat-subscription models first; pay-per-token ones only by explicit opt-in. */
export const DEFAULT_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"];
const REASONING = process.env.PI_MEETING_REASONING || "low";
const QMD_COLLECTIONS = (process.env.PI_MEETING_QMD_COLLECTIONS ?? "wiki,va-eert")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const ABOUT_FILE = process.env.PI_MEETING_ABOUT || path.join(os.homedir(), ".pi/agent/meeting-context.md");

const DAILY_DIR = process.env.PI_MEETING_DAILY_DIR ?? path.join(os.homedir(), "Documents/Wiki/daily");
/** Research subagents: the session model unless overridden, read-only tools, a hard time cap. */
const DIG_MODEL = process.env.PI_MEETING_RESEARCH_MODEL || "";
const DIG_THINKING = process.env.PI_MEETING_RESEARCH_THINKING || "medium";
const DIG_TOOLS = "read,bash,web_search,web_fetch";
export const DIG_TIMEOUT_MS = 3 * 60_000;
const MAX_DIGS = 2;
const DIG_TRANSCRIPT_CHARS = 8000;

export const TRIGGER = { batch: 6, quietMs: 2500, maxWaitMs: 45_000, minGapMs: 15_000, flood: 14 };
/** Questions in the compact widget, and the least time one stays there unless answered. */
export const SHOWN = 3;
export const HOLD_MS = 3 * 60_000;
const MAX_ADD = 1;
const MAX_ADD_FIRST = 2;
const EXPANDED_ROWS = 18;
const POLL_MS = 1000;
const RENDER_MS = 10_000;
const MAX_TRANSCRIPT_CHARS = 100_000;
const PREV_TRANSCRIPT_CHARS = 16_000;
export const RECONNECT_MS = 90_000;
const LIVE_STALE_MS = 15 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
const BACKGROUND_WAIT_MS = 10_000;
const REPLY_TTL_MS = 3 * 60_000;
const NOTIFY_GAP_MS = 30_000;
const MSG_TYPE = "meeting";
const WIDGET_KEY = "meeting";
const INVITE_RE = /\bany (?:other |more |last )?questions\b|\bquestions\s*\?|\bthoughts\s*\?|\banyone (?:else )?(?:have|got) anything\b/i;

// ── transcript parsing ───────────────────────────────────────────────────────

export type MeetingEvent =
	| { kind: "meta"; title?: string; app?: string; startedAt?: string; stopped: boolean }
	| { kind: "line"; ts: string; speaker: string; text: string; chat: boolean }
	| { kind: "people"; people: string[] };

/** One meeting-capture jsonl record, normalized; null for anything unusable. */
export function parseEvent(raw: string): MeetingEvent | null {
	let ev: Record<string, unknown>;
	try {
		ev = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!ev || typeof ev !== "object") return null;
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (ev.type) {
		case "metadata":
			return {
				kind: "meta",
				title: str(ev.meeting) || undefined,
				app: str(ev.app) || undefined,
				startedAt: str(ev.meeting_started_at) || undefined,
				stopped: ev.event === "stopped",
			};
		case "caption":
		case "chat": {
			const text = str(ev.text).replace(/\s+/g, " ").trim();
			if (!text) return null;
			return { kind: "line", ts: str(ev.ts), speaker: str(ev.speaker) || "Unknown", text, chat: ev.type === "chat" };
		}
		case "people":
			return Array.isArray(ev.people)
				? { kind: "people", people: ev.people.filter((p): p is string => typeof p === "string") }
				: null;
		default:
			return null;
	}
}

/** "HH:MM:SS" straight from the ISO string, so it stays in the meeting's local time. */
export const clock = (ts: string) => /T(\d\d:\d\d:\d\d)/.exec(ts)?.[1] ?? "";

export const formatLine = (l: { ts: string; speaker: string; text: string; chat: boolean }) =>
	`[${clock(l.ts)}] ${l.chat ? "(chat) " : ""}${l.speaker}: ${l.text}`;

/** Lowercase name parts of 3+ letters: "Boehs, Eric (ORG)" and "Eric Boehs" both → eric, boehs. */
export function nameTokens(name: string): string[] {
	const parts = name
		.replace(/\(.*?\)/g, " ")
		.split(/[^\p{L}'-]+/u)
		.map((s) => s.toLowerCase())
		.filter((s) => s.length >= 3);
	return [...new Set(parts)];
}

export function isMe(speaker: string, me: string[]): boolean {
	if (me.length === 0) return false;
	const sp = new Set(nameTokens(speaker));
	return me.every((t) => sp.has(t));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mentionsMe(text: string, me: string[]): boolean {
	return me.some((t) => new RegExp(`(^|[^\\p{L}])${escapeRe(t)}($|[^\\p{L}])`, "iu").test(text));
}

export const isInvite = (text: string) => INVITE_RE.test(text);

// ── triggers ─────────────────────────────────────────────────────────────────

export type Cue = "mention" | "invite" | null;
export type TriggerState = {
	unsent: number; // lines since the last check
	firstUnsentAt: number; // arrival of the oldest unchecked line (ms)
	lastLineAt: number; // arrival of the newest line (ms)
	lastCallAt: number; // start of the last check (ms)
	cue: Cue;
};

export const freshTrigger = (): TriggerState => ({ unsent: 0, firstUnsentAt: 0, lastLineAt: 0, lastCallAt: 0, cue: null });

/**
 * Whether to spend a model call now. Pure, so the cadence is testable.
 * `final` (meeting over) drops the batch threshold: whatever is left gets one look.
 */
export function shouldFire(t: TriggerState, now: number, final = false, cfg = TRIGGER): "cue" | "batch" | null {
	if (t.unsent === 0) return null;
	const quiet = now - t.lastLineAt;
	// A cue is a fast path, not a gate: if talk runs on, the normal rules still apply.
	if (t.cue && quiet >= cfg.quietMs / 2) return "cue";
	if (now - t.lastCallAt < cfg.minGapMs) return null;
	if (t.unsent >= cfg.flood) return "batch";
	if (quiet < cfg.quietMs) return null;
	if (final || t.unsent >= cfg.batch || now - t.firstUnsentAt >= cfg.maxWaitMs) return "batch";
	return null;
}

// ── scout replies ────────────────────────────────────────────────────────────

export type Closure = { id: number; by: "asked" | "answered"; note: string };
export type ScoutUpdate = { topic: string; add: { q: string; why: string }[]; closed: Closure[]; top: number[]; reply: string };
export type Question = {
	id: number;
	q: string;
	why: string;
	at: number; // when it was added (ms), for the widget hold
	clock: string; // meeting time it was added, "HH:MM"
	status: "open" | "asked" | "answered";
	closedClock?: string;
	note?: string; // the answer, when one was given
	dig?: Dig; // a research subagent's run on this question
};

export type Dig = {
	state: "running" | "done" | "failed";
	startedAt: number;
	answer?: string; // one line, for the widget and the recap
	brief?: string;
	error?: string;
};

const toId = (v: unknown) => (typeof v === "number" ? v : Number.parseInt(String(v ?? "").replace(/^\s*Q/i, ""), 10));

/** The scout's JSON, tolerant of code fences, prose around it, and loose types. */
export function parseScoutReply(text: string): ScoutUpdate | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
	const add = (Array.isArray(obj.add) ? obj.add : [])
		.map((a: unknown) => {
			if (typeof a === "string") return { q: s(a, 300), why: "" };
			const r = (a ?? {}) as Record<string, unknown>;
			return { q: s(r.q ?? r.question, 300), why: s(r.why, 200) };
		})
		.filter((a) => a.q);
	const closed = (Array.isArray(obj.closed) ? obj.closed : [])
		.map((c: unknown): Closure => {
			if (typeof c !== "object" || c === null) return { id: toId(c), by: "answered", note: "" };
			const r = c as Record<string, unknown>;
			return { id: toId(r.id), by: /ask/i.test(String(r.by ?? "")) ? "asked" : "answered", note: s(r.note ?? r.answer, 160) };
		})
		.filter((c) => Number.isFinite(c.id));
	const top = (Array.isArray(obj.top) ? obj.top : []).map(toId).filter((n) => Number.isFinite(n));
	return { topic: s(obj.topic, 80), add, closed, top, reply: s(obj.reply, 500) };
}

const normQ = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Close what was answered or asked, then add (deduped against every question so
 * far, at most `maxAdd`). Nothing else ever leaves the list.
 */
export function applyUpdate(questions: Question[], u: ScoutUpdate, nextId: number, now: number, clock = "", maxAdd = MAX_ADD) {
	const byId = new Map(u.closed.map((c) => [c.id, c]));
	const closed: Question[] = [];
	const next = questions.map((q) => {
		const c = q.status === "open" ? byId.get(q.id) : undefined;
		if (!c) return q;
		const done: Question = { ...q, status: c.by, closedClock: clock, note: c.note };
		closed.push(done);
		return done;
	});
	const seen = new Set(next.map((q) => normQ(q.q)));
	const added: Question[] = [];
	for (const a of u.add.slice(0, maxAdd)) {
		const k = normQ(a.q);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		added.push({ id: nextId++, q: a.q, why: a.why, at: now, clock, status: "open" });
	}
	return { questions: [...next, ...added], added, closed, nextId };
}

export type Shown = { id: number; since: number };

/**
 * Which open questions the compact widget shows. `prefer` is best-first (new
 * questions, then the scout's ranking); the newest fill in after that. A new
 * question (`fresh`) shows at once; otherwise a shown question gives up its
 * slot only once it has had `holdMs` on screen. Either way it stays on the list.
 */
export function pickShown(
	shown: Shown[],
	questions: Question[],
	prefer: number[],
	now: number,
	fresh: number[] = [],
	n = SHOWN,
	holdMs = HOLD_MS,
): Shown[] {
	const open = new Set(questions.filter((q) => q.status === "open").map((q) => q.id));
	const newest = [...open].sort((a, b) => b - a);
	const rank = [...new Set([...prefer, ...newest])].filter((id) => open.has(id));
	const want = rank.slice(0, n);
	const out = shown.filter((s) => open.has(s.id));
	const held = (s: Shown) => now - s.since >= holdMs;
	for (const id of want) {
		if (out.some((s) => s.id === id)) continue;
		if (out.length < n) {
			out.push({ id, since: now });
			continue;
		}
		// Worst-ranked first, and anything past its hold before anything that isn't.
		const victim = out
			.filter((s) => !want.includes(s.id) && (fresh.includes(id) || held(s)))
			.sort((a, b) => Number(held(b)) - Number(held(a)) || rank.indexOf(b.id) - rank.indexOf(a.id))[0];
		if (!victim) continue;
		out[out.indexOf(victim)] = { id, since: now };
	}
	return out.sort((a, b) => a.id - b.id);
}

// ── prompts ──────────────────────────────────────────────────────────────────

export function buildSystemPrompt(me: string, about: string, background: string): string {
	const who = me || "the user";
	return [
		`You are a live meeting copilot for ${who}. You read the running caption transcript of a meeting ${who} is in and keep a short list of questions ${who} could ask out loud. ${who} glances at the list mid-call, so every item must be worth interrupting for.`,
		"",
		"A good question:",
		"- pins down something left vague that matters: an owner, a date, a scope, a dependency, a risk, a decision nobody made",
		`- connects what is being said to the background: an earlier commitment, ${who}'s own work, a known problem`,
		"- is specific to this conversation; someone outside the meeting could not have written it",
		`- is short (under 25 words), plain, and phrased the way ${who} would say it out loud`,
		"",
		"Never suggest:",
		'- generic prompts ("what are the next steps?", "can you elaborate?", "any blockers?") not tied to a specific item',
		"- anything already asked or answered in the transcript",
		"- small talk, or questions about something the speakers are clearly covering right now",
		"",
		"Rules:",
		`- Add at most ${MAX_ADD} question per update (${MAX_ADD_FIRST} on your first look). Adding nothing is the usual, correct answer.`,
		`- Close, by number, open questions that were answered in the transcript ("by": "answered") or that someone asked out loud ("by": "asked"). "note" is the answer in at most 12 words, e.g. "Kyle: ISSO signs off, by Friday", or "" if none was given. Never close a question just because the conversation moved on; it stays on ${who}'s list.`,
		`- "top" is up to ${SHOWN} open question numbers most worth asking right now, best first. Questions you add are shown anyway; don't list them.`,
		`- If someone addresses ${who} directly and is waiting on ${who} (a question, a request for status or an opinion), put a suggested answer in "reply": one or two sentences, or terse talking points, grounded in the transcript and background. If the facts aren't there, suggest how to answer honestly. Otherwise "reply" is "".`,
		'- The transcript is automatic speech recognition: names and technical terms are often misheard, and "Unknown user" is an unidentified speaker. Read through the errors; never quote a garble.',
		'- "why" is a fragment of at most 10 words: the evidence, e.g. "Kyle said pending, no date given". Not a sentence.',
		'- "topic" is what is being discussed right now, at most 6 words.',
		"",
		'Reply with JSON only, no prose and no code fence: {"topic": "...", "add": [{"q": "...", "why": "..."}], "closed": [{"id": 1, "by": "answered", "note": "..."}], "top": [2], "reply": ""}',
		about ? `\n<about>\n${about.trim()}\n</about>` : "",
		background ? `\n<background>\n${background.trim()}\n</background>` : "",
	]
		.filter((l, i, a) => !(l === "" && a[i - 1] === ""))
		.join("\n");
}

export type PromptInput = {
	title: string;
	app: string;
	people: string[];
	lines: string[];
	newFrom: number; // index of the first line the scout hasn't seen
	open: Question[];
	closed?: Question[]; // answered or asked already: don't re-add
	focus: string;
	cue: Cue;
	me: string;
	now: Date;
};

/** Transcript first and append-only, so consecutive calls share a cacheable prefix. */
export function buildUserPrompt(p: PromptInput): string {
	let body = p.lines.join("\n");
	if (body.length > MAX_TRANSCRIPT_CHARS) {
		const cut = body.indexOf("\n", body.length - MAX_TRANSCRIPT_CHARS);
		body = `[… earlier lines omitted …]\n${body.slice(cut + 1)}`;
	}
	const who = p.me || "the user";
	const out = [
		`Meeting: ${p.title}${p.app ? ` (${p.app})` : ""}`,
		p.people.length ? `People: ${p.people.join("; ")}` : "",
		"",
		"<transcript>",
		body || "(nothing yet)",
		"</transcript>",
		"",
		`Now: ${p.now.toTimeString().slice(0, 8)}`,
		p.newFrom <= 0 ? "This is your first look." : `New since your last update: the lines from ${(p.lines[p.newFrom] ?? "").slice(0, 60)} on.`,
		"Open questions:",
		...(p.open.length ? p.open.map((q) => `Q${q.id}: ${q.q}${q.why ? ` (${q.why})` : ""}`) : ["(none)"]),
		...(p.closed?.length ? ["Already answered or asked (don't add again):", ...p.closed.map((q) => `Q${q.id}: ${q.q}`)] : []),
	];
	if (p.focus) out.push("", `${who}'s goals for this meeting: ${p.focus}`);
	if (p.cue === "mention") out.push("", `${who} was just named in the new lines. Check whether someone is waiting on ${who}.`);
	if (p.cue === "invite") out.push("", "Someone just invited questions. If one question is clearly the best, make sure it is open.");
	return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

// ── files ────────────────────────────────────────────────────────────────────

/** "20261005_125906-teams-eert-weekly-sync.jsonl" → "teams-eert-weekly-sync". */
export const meetingKey = (name: string) => path.basename(name).replace(/^\d{8}_\d{6}-/, "").replace(/\.(jsonl|txt)$/, "");
const stamp = (name: string) => /^(\d{8}_\d{6})-/.exec(path.basename(name))?.[1] ?? "";

export const isCandidate = (name: string) =>
	/^\d{8}_\d{6}-.+\.jsonl$/.test(name) && !/-slack-notifications-|-test-|-merged\./.test(name);

/** Newest candidate whose name contains `filter`; names sort by capture time. */
export function pickNewest(names: string[], filter = ""): string | undefined {
	const f = filter.toLowerCase();
	return names
		.filter((n) => isCandidate(n) && (!f || n.toLowerCase().includes(f)))
		.sort()
		.pop();
}

/** A capture that began at/after `since`, matching `key` (exact) or `filter` (substring). */
export function pickStartedSince(names: string[], since: string, opts: { key?: string; filter?: string } = {}): string | undefined {
	const f = (opts.filter ?? "").toLowerCase();
	return names
		.filter((n) => isCandidate(n) && stamp(n) >= since)
		.filter((n) => (opts.key ? meetingKey(n) === opts.key : !f || n.toLowerCase().includes(f)))
		.sort()
		.pop();
}

/** Largest .txt over 1 KB of the same meeting from the most recent earlier day. */
export function previousTranscript(files: { name: string; size: number }[], current: string): string | undefined {
	const key = meetingKey(current);
	const day = stamp(current).slice(0, 8);
	const prior = files.filter(
		(f) => f.name.endsWith(".txt") && f.size > 1024 && meetingKey(f.name) === key && stamp(f.name).slice(0, 8) < day && stamp(f.name),
	);
	const lastDay = prior.map((f) => stamp(f.name).slice(0, 8)).sort().pop();
	if (!lastDay) return undefined;
	return prior.filter((f) => stamp(f.name).startsWith(lastDay)).sort((a, b) => b.size - a.size)[0]?.name;
}

/** Local time as a filename stamp, for "captures that started after X". */
export function toStamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── recap ────────────────────────────────────────────────────────────────────

const clockSpan = (q: Question) => (q.closedClock && q.closedClock !== q.clock ? `${q.clock}–${q.closedClock}` : q.clock);
const paren = (bits: (string | undefined)[]) => {
	const s = bits.filter(Boolean).join("; ");
	return s ? ` (${s})` : "";
};

/** Every question by outcome: plain markdown that reads the same in a terminal and in Obsidian. */
export function recapBody(questions: Question[]): string[] {
	if (questions.length === 0) return ["No questions came up."];
	const researched = (q: Question) => (q.dig?.state === "done" && q.dig.answer ? [`  - Researched: ${q.dig.answer}`] : []);
	const group = (label: string, qs: Question[], line: (q: Question) => string) =>
		qs.length ? [label, ...qs.flatMap((q) => [line(q), ...researched(q)]), ""] : [];
	const closedLine = (q: Question) => `- Q${q.id} ${q.q}${q.note ? ` → ${q.note}` : ""}${paren([clockSpan(q)])}`;
	const out = [
		...group("Still open (never asked):", questions.filter((q) => q.status === "open"), (q) => `- Q${q.id} ${q.q}${paren([q.clock, q.why])}`),
		...group("Answered:", questions.filter((q) => q.status === "answered"), closedLine),
		...group("Asked:", questions.filter((q) => q.status === "asked"), closedLine),
	];
	while (out.at(-1) === "") out.pop();
	return out;
}

/** Hidden marker that ties a daily-note block to its capture, so a rewrite replaces it. */
export const recapMarker = (file: string) => `<!-- meeting-copilot:${path.basename(file).replace(/\.(jsonl|txt)$/, "")} -->`;

export type RecapInput = { title: string; file: string; from: string; to: string; checks: number; questions: Question[] };

export function recapBlock(r: RecapInput): string {
	const span = [r.from, r.to].filter(Boolean).join("–");
	return [
		`### ${span ? `${span} ` : ""}${r.title} · copilot questions`,
		recapMarker(r.file),
		`Transcript: \`${r.file.replace(/\.jsonl$/, ".txt").replace(os.homedir(), "~")}\` · ${r.checks} check${r.checks === 1 ? "" : "s"}`,
		"",
		...recapBody(r.questions),
	].join("\n");
}

/**
 * Put `block` in `note`: over the block carrying `marker` if there is one, else
 * at the end of the `heading` section, else in a new section at the end. The
 * rest of the note is left byte-for-byte alone.
 */
export function upsertRecap(note: string, block: string, marker: string, heading = "## Meetings"): string {
	const lines = note.replace(/\n+$/, "").split("\n");
	const body = block.replace(/\n+$/, "").split("\n");
	const nextHeading = (from: number, re: RegExp) => {
		const i = lines.findIndex((l, j) => j > from && re.test(l));
		return i < 0 ? lines.length : i;
	};
	const splice = (start: number, end: number) => {
		const tail = lines.slice(end);
		return `${[...lines.slice(0, start), ...body, ...(tail.length ? ["", ...tail] : [])].join("\n")}\n`;
	};
	const mi = lines.findIndex((l) => l.includes(marker));
	if (mi >= 0) return splice(mi > 0 && /^###\s/.test(lines[mi - 1] ?? "") ? mi - 1 : mi, nextHeading(mi, /^#{1,6}\s/));
	const hi = lines.findIndex((l) => l.trim() === heading);
	if (hi < 0) return `${note.trim() ? `${lines.join("\n")}\n\n` : ""}${heading}\n\n${body.join("\n")}\n`;
	const end = nextHeading(hi, /^#{1,2}\s/);
	let at = end;
	while (at > hi + 1 && (lines[at - 1] ?? "").trim() === "") at--;
	const tail = lines.slice(end);
	return `${[...lines.slice(0, at), "", ...body, ...(tail.length ? ["", ...tail] : [])].join("\n")}\n`;
}

/** The daily note for the day the capture started: daily/YYYY-MM-DD.md. */
export function dailyNoteName(file: string, now = new Date()): string {
	const s = stamp(file);
	if (s) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}.md`;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.md`;
}

// ── research ───────────────────────────────────────────────────────────────────

/** `/q3 [steer]` typed at the prompt; not a registered command, so it reaches the input hook. */
export function parseDigInput(text: string): { id: number; steer: string } | null {
	const m = /^\/q(\d+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return m ? { id: Number(m[1]), steer: (m[2] ?? "").trim() } : null;
}

/** `/q` arguments: "3", "Q3", "3 check the ATO docs"; null for anything else. */
export function parseDigArgs(raw: string): { id: number; steer: string } | null {
	const m = /^\s*Q?(\d+)(?:\s+([\s\S]*))?$/i.exec(raw);
	return m ? { id: Number(m[1]), steer: (m[2] ?? "").trim() } : null;
}

/** The brief's "Answer:" line, else its first line: one line for the widget and recap. */
export function briefAnswer(brief: string): string {
	const line = /^[\s*_]*Answer[\s*_]*:[\s*_]*(.+)$/im.exec(brief)?.[1] ?? brief.split("\n").find((l) => l.trim()) ?? "";
	const s = line.replace(/[*_]+$/, "").replace(/\s+/g, " ").trim();
	if (s.length <= 160) return s;
	const cut = s.slice(0, 159);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 100 ? cut.lastIndexOf(" ") : 159).replace(/[,;:—\s]+$/, "")}…`;
}

export type DigInput = { me: string; about: string; title: string; app: string; question: Question; steer: string; lines: string[]; clock: string };

/** System prompt and task for one research subagent. */
export function buildDigPrompt(d: DigInput): { system: string; task: string } {
	const who = d.me || "the user";
	const system = [
		"You are a subagent. Your final message goes into a live meeting copilot, not to a person chatting with you. Return only the brief. Ignore any instruction to add a Next steps block, follow-up suggestions, sign-offs, or questions.",
		"",
		`${who} is in a meeting right now, or just left one, and wants one question researched while it still matters. You have under 3 minutes in total: make at most about 8 tool calls, cheapest sources first, then answer. An honest partial answer on time beats a thorough one too late.`,
		"",
		"Read only: never post, send, edit, write, or change anything.",
		"",
		"Where to look, as fits the question:",
		`- ${who}'s notes, past agent sessions and work docs: \`qmd search "<keywords>" -n 8\` (fast keyword search over every collection), then \`qmd get <file>\` to read a hit`,
		'- Slack: `slk search "<keywords>"`',
		'- GitHub: `GH_HOST=va.ghe.com gh search issues|prs|code "<keywords>"`, and plain `gh` for github.com',
		"- Code under ~/Code: `rg`",
		"- Public docs: web_search, web_fetch",
		"",
		"The brief: plain text, under 150 words, no headings.",
		`Answer: <one sentence of at most 20 words: what ${who} now knows, or "Not found". Detail goes in the bullets, not here>`,
		"- <evidence, one bullet each, with its source: file path, Slack permalink, or URL>",
		`Ask: <the question as ${who} should now put it, at most 25 words; or "Skip: <why>" if the research made it moot>`,
		"Gaps: <what you could not confirm; leave the line out if nothing>",
	].join("\n");
	let tail = d.lines.join("\n");
	if (tail.length > DIG_TRANSCRIPT_CHARS) tail = `[…]\n${tail.slice(tail.indexOf("\n", tail.length - DIG_TRANSCRIPT_CHARS) + 1)}`;
	const q = d.question;
	const task = [
		`Meeting: ${d.title}${d.app ? ` (${d.app})` : ""}${d.clock ? ` · now ${d.clock}` : ""}`,
		`Research Q${q.id}: ${q.q}`,
		q.why ? `Why it came up: ${q.why}` : "",
		q.note ? `Already said in the meeting: ${q.note}` : "",
		d.steer ? `${who} adds: ${d.steer}` : "",
		d.about ? `\n<about>\n${d.about.trim()}\n</about>` : "",
		`\n<transcript, the latest part>\n${tail || "(empty)"}\n</transcript>`,
	]
		.filter(Boolean)
		.join("\n");
	return { system, task };
}

// ── args ─────────────────────────────────────────────────────────────────────

export type Args = {
	sub: "status" | "start" | "stop" | "ask" | "focus" | "list" | "recap";
	target: string;
	rest: string;
	wake: boolean;
	replay?: number;
	model?: string;
};

export function parseArgs(raw: string): Args {
	const trimmed = raw.trim();
	const first = trimmed.split(/\s+/)[0] ?? "";
	const known = ["start", "stop", "ask", "focus", "status", "list", "recap"] as const;
	const word = first === "expand" ? "list" : first;
	const sub = (known as readonly string[]).includes(word) ? (word as Args["sub"]) : trimmed ? "start" : "status";
	const rest = sub === "start" && first !== "start" ? trimmed : trimmed.slice(first.length).trim();
	const out: Args = { sub, target: "", rest, wake: false };
	if (sub !== "start") return out;
	const tokens = rest.split(/\s+/).filter(Boolean);
	const target: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "--wake") out.wake = true;
		else if (t === "--model") out.model = tokens[++i];
		else if (t === "--replay") {
			const n = Number(tokens[i + 1]);
			out.replay = Number.isFinite(n) && n > 0 ? (i++, n) : 10;
		} else target.push(t);
	}
	out.target = target.join(" ").replace(/^~(?=\/|$)/, os.homedir());
	return out;
}

// ── widget ───────────────────────────────────────────────────────────────────

export type WidgetView = {
	phase: "waiting" | "live" | "ended";
	title: string;
	filter: string;
	startedMs: number;
	topic: string;
	checks: number;
	cost: number;
	busy: boolean;
	error: string;
	questions: Question[];
	shown: number[]; // ids for the compact view
	expanded: boolean;
	reply: string;
	replay: boolean;
	endsAt: number; // when an ended call gives up on a reconnect (ms); 0 if not ended
};

export function humanElapsed(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

const mmss = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const mmssSince = (t: number) => mmss(Date.now() - t);

export function widgetLines(v: WidgetView, theme: Pick<Theme, "fg">, width: number, now = Date.now()): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const fit = (s: string) => truncateToWidth(s, width);
	if (v.phase === "waiting") {
		return [fit(`${dim("◌")} ${dim(`meeting · waiting for a meeting${v.filter ? ` matching "${v.filter}"` : ""} · /meeting stop`)}`)];
	}
	const digging = v.questions.some((q) => q.dig?.state === "running");
	const ended = v.replay
		? digging
			? "replay done · finishing research"
			: "replay done"
		: v.endsAt > now
			? `call ended · stopping in ${mmss(v.endsAt - now)} unless it resumes`
			: digging
				? "call ended · finishing research"
				: "call ended";
	const icon = v.error ? theme.fg("warning", "✕") : v.busy ? theme.fg("accent", "◐") : theme.fg("accent", "●");
	const bits = [
		`meeting${v.replay ? " (replay)" : ""}`,
		v.title,
		v.startedMs ? humanElapsed(now - v.startedMs) : "",
		v.phase === "ended" ? ended : v.topic,
		`${v.checks} check${v.checks === 1 ? "" : "s"}${v.cost > 0 ? ` $${v.cost.toFixed(3)}` : ""}`,
		v.busy ? "checking…" : "",
		v.error ? `error: ${v.error}` : "",
		"/meeting stop",
	].filter(Boolean);
	const lines = [fit(`${icon} ${dim(bits.join(" · "))}`)];
	const inner = Math.max(10, width - 4);
	const open = v.questions.filter((q) => q.status === "open");
	const done = v.questions.filter((q) => q.status !== "open");
	const digTag = (q: Question) =>
		q.dig?.state === "running"
			? theme.fg("warning", ` 🔎 ${mmss(now - q.dig.startedAt)}`)
			: q.dig?.state === "failed"
				? theme.fg("warning", " 🔎✕")
				: q.dig?.state === "done"
					? theme.fg("success", " 🔎✓")
					: "";
	const id = (q: Question) => theme.fg("accent", `Q${q.id}`) + digTag(q);
	if (v.expanded) {
		// One line each: all open questions, then the closed ones while they fit.
		const openRows = open.length > EXPANDED_ROWS ? EXPANDED_ROWS - 1 : open.length;
		for (const q of open.slice(0, openRows)) lines.push(fit(`  ${id(q)} ${q.q}${q.why ? dim(` — ${q.why}`) : ""}`));
		if (open.length > openRows) lines.push(fit(dim(`  +${open.length - openRows} more open · /meeting recap`)));
		const room = EXPANDED_ROWS - Math.min(open.length, EXPANDED_ROWS);
		const doneRows = done.length > room ? Math.max(0, room - 1) : done.length;
		for (const q of doneRows ? done.slice(-doneRows) : [])
			lines.push(fit(dim(`  ✓ Q${q.id} ${q.q}${q.note ? ` → ${q.note}` : ` (${q.status})`}`)));
		if (done.length > doneRows) lines.push(fit(dim(`  ✓ ${done.length - doneRows} more answered or asked · /meeting recap`)));
		if (v.questions.length === 0) lines.push(fit(dim("  no questions yet")));
		else lines.push(fit(dim("  /meeting list to collapse")));
	} else {
		const shown = open.filter((q) => v.shown.includes(q.id));
		for (const q of shown) {
			const wrapped = wrapTextWithAnsi(`${id(q)} ${q.q}${q.why ? dim(` — ${q.why}`) : ""}`, inner);
			for (const l of wrapped.slice(0, 3)) lines.push(fit(`  ${l}`));
			if (q.dig?.state === "done" && q.dig.answer) lines.push(fit(`    ${theme.fg("success", `→ ${q.dig.answer}`)}`));
		}
		const more = open.length - shown.length;
		const bits2 = [more > 0 ? `+${more} more open` : "", done.length ? `${done.length} answered or asked` : ""].filter(Boolean);
		if (bits2.length) lines.push(fit(dim(`  ${bits2.join(" · ")} · /meeting list`)));
	}
	if (v.reply) {
		for (const l of wrapTextWithAnsi(theme.fg("success", `↳ say: ${v.reply}`), inner).slice(0, 4)) lines.push(fit(`  ${l}`));
	}
	return lines;
}

// ── runtime ──────────────────────────────────────────────────────────────────

type Meeting = {
	phase: WidgetView["phase"];
	filter: string;
	file: string; // current .jsonl, "" while waiting
	waitSince: string; // filename stamp: only captures starting at/after this count
	offset: number;
	partial: string;
	replay?: { speed: number; events: { at: number; ev: MeetingEvent }[]; next: number; t0: number; startedAt: number };
	title: string;
	app: string;
	startedMs: number;
	people: string[];
	lines: string[];
	sentUpTo: number;
	trig: TriggerState;
	questions: Question[]; // every question so far; only answered/asked ones close
	shown: Shown[];
	expanded: boolean;
	firstFile: string; // the capture the meeting started in; keys the daily-note recap
	nextId: number;
	topic: string;
	reply: string;
	replyAt: number;
	focus: string;
	wake: boolean;
	me: string;
	meTokens: string[];
	models: Model<Api>[];
	modelLabel: string;
	system: string;
	backgroundReady?: Promise<void>;
	sessionId: string;
	checks: number;
	cost: number;
	busy: boolean;
	forceNext: boolean;
	error: string;
	abort?: AbortController;
	endedAt: number;
	lastRender: number;
	lastNotify: number;
	announced: boolean;
};

const run = (cmd: string, args: string[], timeout: number) =>
	new Promise<string>((resolve) => {
		execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
	});

async function readTail(file: string, max: number): Promise<string> {
	try {
		const fh = await fs.promises.open(file, "r");
		try {
			const { size } = await fh.stat();
			const len = Math.min(size, max);
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, size - len);
			const text = buf.toString("utf8");
			return len < size ? text.slice(text.indexOf("\n") + 1) : text;
		} finally {
			await fh.close();
		}
	} catch {
		return "";
	}
}

async function qmdNotes(title: string): Promise<string> {
	if (QMD_COLLECTIONS.length === 0 || title.replace(/\W/g, "").length < 4) return "";
	const args = ["search", title, ...QMD_COLLECTIONS.flatMap((c) => ["-c", c]), "-n", "6", "--json"];
	const out = await run("qmd", args, 8000);
	try {
		const hits = JSON.parse(out) as { file?: string; title?: string; snippet?: string }[];
		return hits
			.map((h) => {
				const snippet = String(h.snippet ?? "")
					.replace(/^@@[^\n]*\n/, "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 600);
				return `- ${String(h.file ?? "").replace(/^qmd:\/\//, "")}: ${snippet}`;
			})
			.join("\n");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let st: Meeting | undefined;
	/** The meeting that just finished: /q can still research its questions. */
	let last: Meeting | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ticking = false;

	type DigRun = { m: Meeting; id: number; proc: ChildProcess; cancelled: boolean };
	const digRuns = new Set<DigRun>();
	const digging = (m: Meeting) => m.questions.some((q) => q.dig?.state === "running");
	const cancelDigs = (m?: Meeting) => {
		for (const r of digRuns) {
			if (m && r.m !== m) continue;
			r.cancelled = true;
			r.proc.kill("SIGTERM");
			digRuns.delete(r);
			setDig(r.m, r.id, { state: "failed", startedAt: r.m.questions.find((q) => q.id === r.id)?.dig?.startedAt ?? 0, error: "cancelled" });
		}
	};
	function setDig(m: Meeting, id: number, dig: Dig) {
		m.questions = m.questions.map((q) => (q.id === id ? { ...q, dig } : q));
	}

	// Timers outlive the command that started them, so they use the session's
	// own context rather than a command context.
	pi.on("session_start", (_e, ctx) => {
		ctxRef = ctx;
	});
	pi.on("session_shutdown", () => {
		// Quitting mid-meeting still leaves the recap in the daily note.
		if (st && !st.replay && st.questions.length) writeRecap(st);
		teardown();
		cancelDigs();
		ctxRef = undefined;
	});

	pi.registerMessageRenderer(MSG_TYPE, (message, options, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const styled = text
			.split("\n")
			.map((l, i) =>
				i === 0
					? `${theme.fg("accent", "◆")} ${theme.fg("dim", l)}`
					: l.startsWith("−") || l.startsWith("✓")
						? theme.fg("dim", l)
						: l.startsWith("↳") || l.startsWith("Answer:")
							? theme.fg("success", l)
							: l,
			)
			.join("\n");
		return new Text(styled, options.outputPad ?? 1, 0);
	});

	// ── lifecycle ──

	function teardown() {
		if (timer) clearInterval(timer);
		timer = undefined;
		st?.abort?.abort();
		if (st) {
			cancelDigs(st); // only /meeting stop gets here with research running; a natural end waits
			last = st;
		}
		st = undefined;
		if (ctxRef?.mode === "tui") ctxRef.ui.setWidget(WIDGET_KEY, undefined);
	}

	const lineClock = (l?: string) => /^\[(\d\d:\d\d)/.exec(l ?? "")?.[1] ?? "";
	const tilde = (p: string) => p.replace(os.homedir(), "~");

	function notePath(m: Meeting): string | undefined {
		if (m.replay || !DAILY_DIR || !fs.existsSync(DAILY_DIR)) return undefined;
		return path.join(DAILY_DIR, dailyNoteName(m.firstFile || m.file));
	}

	/** Write or rewrite this meeting's block under ## Meetings. Sync: it also runs from session_shutdown. */
	function writeRecap(m: Meeting): string | undefined {
		const file = notePath(m);
		if (!file) return undefined;
		const source = m.firstFile || m.file;
		const block = recapBlock({
			title: m.title,
			file: source,
			from: lineClock(m.lines[0]),
			to: lineClock(m.lines.at(-1)),
			checks: m.checks,
			questions: m.questions,
		});
		try {
			const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
			fs.writeFileSync(file, upsertRecap(before, block, recapMarker(source)));
			return file;
		} catch (e) {
			if (ctxRef?.hasUI) ctxRef.ui.notify(`Meeting recap not written to ${tilde(file)}: ${(e as Error).message}`, "error");
			return undefined;
		}
	}

	/** Post the recap to the session (and the daily note, unless it's a replay or empty). */
	function postRecap(m: Meeting, headline: string) {
		const note = m.questions.length ? writeRecap(m) : undefined;
		pi.sendMessage(
			{
				customType: MSG_TYPE,
				content: [`${headline}${note ? ` · recap in ${tilde(note)}` : ""}`, ...recapBody(m.questions)].join("\n"),
				display: true,
				details: { kind: "recap", questions: m.questions, note },
			},
			{ triggerTurn: false },
		);
	}

	function finish(reason: string) {
		const m = st;
		if (!m) return;
		if (m.announced) {
			postRecap(m, `Meeting copilot stopped (${reason}) · ${m.checks} checks · transcript: ${tilde(m.file.replace(/\.jsonl$/, ".txt"))}`);
		} else if (ctxRef?.hasUI) {
			ctxRef.ui.notify(`Meeting copilot stopped (${reason})`, "info");
		}
		teardown();
	}

	function render(force = false) {
		const m = st;
		const ctx = ctxRef;
		if (!m || ctx?.mode !== "tui") return;
		const now = Date.now();
		if (!force && now - m.lastRender < RENDER_MS) return;
		m.lastRender = now;
		if (m.reply && now - m.replyAt > REPLY_TTL_MS) m.reply = "";
		const view: WidgetView = {
			phase: m.phase,
			title: m.title,
			filter: m.filter,
			startedMs: m.startedMs,
			topic: m.topic,
			checks: m.checks,
			cost: m.cost,
			busy: m.busy,
			error: m.error,
			questions: m.questions,
			shown: m.shown.map((s) => s.id),
			expanded: m.expanded,
			reply: m.reply,
			replay: !!m.replay,
			endsAt: m.phase === "ended" && !m.replay ? m.endedAt + RECONNECT_MS : 0,
		};
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({ render: (width: number) => widgetLines(view, theme, width), invalidate() {} }),
			{ placement: "aboveEditor" },
		);
	}

	// ── ingest ──

	function ingest(ev: MeetingEvent, now: number, history: boolean) {
		const m = st;
		if (!m) return;
		if (ev.kind === "meta") {
			if (ev.title) m.title = ev.title;
			if (ev.app) m.app = ev.app;
			if (ev.startedAt) m.startedMs = Date.parse(ev.startedAt) || m.startedMs;
			if (ev.stopped) {
				m.phase = "ended";
				// An already-finished file: one look, then done, no reconnect wait.
				m.endedAt = history ? now - RECONNECT_MS : now;
			}
			return;
		}
		if (ev.kind === "people") {
			m.people = ev.people;
			return;
		}
		m.lines.push(formatLine(ev));
		if (!m.trig.unsent) m.trig.firstUnsentAt = history ? 0 : now;
		m.trig.unsent++;
		m.trig.lastLineAt = history ? 0 : now;
		if (history || isMe(ev.speaker, m.meTokens)) return;
		if (mentionsMe(ev.text, m.meTokens)) {
			m.trig.cue = "mention";
			if (ctxRef?.hasUI && now - m.lastNotify > NOTIFY_GAP_MS) {
				m.lastNotify = now;
				ctxRef.ui.notify(`Meeting: ${ev.speaker}: ${ev.text.slice(0, 140)}`, "info");
			}
		} else if (!m.trig.cue && isInvite(ev.text)) {
			m.trig.cue = "invite";
		}
	}

	async function attach(file: string, history: boolean) {
		const m = st;
		if (!m) return;
		const continuing = m.file !== "" && meetingKey(m.file) === meetingKey(file);
		m.file = file;
		if (!m.firstFile) m.firstFile = file;
		m.offset = 0;
		m.partial = "";
		m.phase = "live";
		if (!continuing) m.title = meetingKey(file);
		await pollFile(history); // reads the metadata line, so the title is real for qmd
		if (!continuing) m.backgroundReady = buildBackground(file);
		if (!m.announced && st === m) {
			m.announced = true;
			pi.sendMessage(
				{
					customType: MSG_TYPE,
					content: `Meeting copilot on "${m.title}"${m.app ? ` (${m.app})` : ""} via ${m.modelLabel}. Live transcript: ${file.replace(/\.jsonl$/, ".txt")}. These updates are context for later; they need no reply.`,
					display: true,
					details: { kind: "start", file },
				},
				{ triggerTurn: false },
			);
		}
		render(true);
	}

	async function pollFile(history = false) {
		const m = st;
		if (!m || !m.file) return;
		let size: number;
		try {
			size = (await fs.promises.stat(m.file)).size;
		} catch {
			return;
		}
		if (size < m.offset) {
			m.offset = 0;
			m.partial = "";
		}
		if (size === m.offset) return;
		const fh = await fs.promises.open(m.file, "r");
		let chunk: string;
		try {
			const buf = Buffer.alloc(size - m.offset);
			await fh.read(buf, 0, buf.length, m.offset);
			chunk = buf.toString("utf8");
		} finally {
			await fh.close();
		}
		m.offset = size;
		const parts = (m.partial + chunk).split("\n");
		m.partial = parts.pop() ?? "";
		const now = Date.now();
		for (const raw of parts) {
			const ev = raw.trim() ? parseEvent(raw) : null;
			if (ev) ingest(ev, now, history);
		}
	}

	async function listNames(): Promise<string[]> {
		try {
			return await fs.promises.readdir(DIR);
		} catch {
			return [];
		}
	}

	async function buildBackground(file: string): Promise<void> {
		const m = st;
		if (!m) return;
		const [about, names] = await Promise.all([
			fs.promises.readFile(ABOUT_FILE, "utf8").then((s) => s.slice(0, 4000), () => ""),
			listNames(),
		]);
		const txts = await Promise.all(
			names
				.filter((n) => n.endsWith(".txt") && meetingKey(n) === meetingKey(file))
				.map(async (name) => ({ name, size: (await fs.promises.stat(path.join(DIR, name)).catch(() => ({ size: 0 }))).size })),
		);
		const prev = previousTranscript(txts, path.basename(file));
		const [prevText, notes] = await Promise.all([
			prev ? readTail(path.join(DIR, prev), PREV_TRANSCRIPT_CHARS) : Promise.resolve(""),
			qmdNotes(m.title),
		]);
		if (st !== m) return;
		const bg = [
			prevText ? `## The previous "${m.title}" (${prev}), last part\n${prevText.trim()}` : "",
			notes ? `## Notes that mention "${m.title}" (qmd search)\n${notes}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		m.system = buildSystemPrompt(m.me, about, bg);
	}

	// ── checks ──

	async function check() {
		const m = st;
		const ctx = ctxRef;
		if (!m || !ctx || m.busy) return;
		const registry = ctx.modelRegistry;
		const newFrom = m.sentUpTo;
		const upTo = m.lines.length;
		const cue = m.trig.cue;
		const saved = { ...m.trig };
		m.trig = { unsent: 0, firstUnsentAt: 0, lastLineAt: m.trig.lastLineAt, lastCallAt: Date.now(), cue: null };
		m.busy = true;
		m.abort = new AbortController();
		render(true);
		try {
			if (m.backgroundReady) await Promise.race([m.backgroundReady, new Promise((r) => setTimeout(r, BACKGROUND_WAIT_MS))]);
			const user = buildUserPrompt({
				title: m.title,
				app: m.app,
				people: m.people,
				lines: m.lines.slice(0, upTo),
				newFrom,
				open: m.questions.filter((q) => q.status === "open"),
				closed: m.questions.filter((q) => q.status !== "open"),
				focus: m.focus,
				cue,
				me: m.me,
				now: new Date(),
			});
			const system = m.system || buildSystemPrompt(m.me, "", "");
			let res: AssistantMessage | undefined;
			const errors: string[] = [];
			for (const model of m.models) {
				const stream = registry.streamSimple(
					model,
					{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
					{
						...(REASONING === "off" ? {} : { reasoning: REASONING as ThinkingLevel }),
						maxTokens: 4000,
						cacheRetention: "short",
						sessionId: m.sessionId,
						signal: AbortSignal.any([m.abort.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
					},
				);
				const r = await stream.result();
				m.cost += r.usage?.cost?.total ?? 0;
				if (r.stopReason === "error" || r.stopReason === "aborted") {
					errors.push(`${model.provider}/${model.id}: ${(r.errorMessage || r.stopReason).slice(0, 80)}`);
					if (m.abort.signal.aborted) break;
					continue;
				}
				res = r;
				break;
			}
			if (st !== m) return;
			m.checks++;
			if (!res) throw new Error(errors.join("; ") || "no model answered");
			const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			const update = parseScoutReply(text);
			if (!update) throw new Error(`unparseable reply: ${text.replace(/\s+/g, " ").slice(0, 60)}`);
			m.error = "";
			m.sentUpTo = upTo;
			if (update.topic) m.topic = update.topic;
			// Stamp with meeting time (the last line checked), not wall time.
			const at = lineClock(m.lines[upTo - 1]) || new Date().toTimeString().slice(0, 5);
			const now = Date.now();
			const applied = applyUpdate(m.questions, update, m.nextId, now, at, newFrom === 0 ? MAX_ADD_FIRST : MAX_ADD);
			m.questions = applied.questions;
			m.nextId = applied.nextId;
			const addedIds = applied.added.map((q) => q.id);
			m.shown = pickShown(m.shown, m.questions, [...addedIds].reverse().concat(update.top), now, addedIds);
			if (update.reply) {
				m.reply = update.reply;
				m.replyAt = now;
			}
			deliver(m, applied.added, applied.closed, update.reply, cue, at);
		} catch (e) {
			if (st !== m) return;
			m.error = String((e as Error)?.message ?? e).slice(0, 120);
			// Nothing was consumed: put the lines and the cue back for the next trigger.
			m.trig.unsent += saved.unsent;
			m.trig.firstUnsentAt = saved.firstUnsentAt || Date.now();
			m.trig.cue = m.trig.cue ?? saved.cue;
		} finally {
			if (st === m) {
				m.busy = false;
				m.abort = undefined;
				render(true);
			}
		}
	}

	function deliver(m: Meeting, added: Question[], closed: Question[], reply: string, cue: Cue, at: string) {
		// Close-only changes stay in the widget (and the recap); the session hears about new things.
		if (added.length === 0 && !reply) return;
		const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
		const lines = [`Meeting copilot · ${m.title} · ${at}${m.topic ? ` · ${m.topic}` : ""}`];
		for (const q of added) lines.push(`+ Q${q.id} ${q.q}${q.why ? ` (${q.why})` : ""}`);
		for (const q of closed) lines.push(`✓ Q${q.id} ${short(q.q, 80)}${q.note ? ` → ${q.note}` : ` (${q.status})`}`);
		if (reply) lines.push(`↳ suggested reply: ${reply}`);
		const wake = m.wake && cue === "mention" && !!reply;
		if (wake) lines.push(`${m.me || "The user"} was just addressed in the meeting. Reply with 2-3 sentences ${m.me || "they"} could say now; no tools.`);
		pi.sendMessage(
			{ customType: MSG_TYPE, content: lines.join("\n"), display: true, details: { kind: "update", added, closed, reply } },
			wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
		);
	}

	// ── research ──

	const piInvocation = (args: string[]) => {
		const script = process.argv[1];
		return script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)
			? { cmd: process.execPath, args: [script, ...args] }
			: { cmd: "pi", args };
	};

	/**
	 * Research one question in a separate `pi -p` subprocess: nothing runs in the
	 * main session, and the brief arrives as a meeting message (triggerTurn:false).
	 */
	async function research(id: number, steer: string, ctx: ExtensionContext): Promise<void> {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		const m = st ?? last;
		if (!m) return notify("No meeting to research. /meeting start", "warning");
		const q = m.questions.find((x) => x.id === id);
		if (!q) return notify(`No Q${id} in "${m.title}"`, "warning");
		if (q.dig?.state === "running") return notify(`Already researching Q${id} (${mmssSince(q.dig.startedAt)})`);
		if (q.dig?.state === "done" && !steer) return notify(`Q${id}: ${q.dig.answer} · brief is above · /q${id} <what else> digs again`);
		const running = m.questions.filter((x) => x.dig?.state === "running").length;
		if (running >= MAX_DIGS) return notify(`${running} research runs already going; try again when one lands`, "warning");

		// Claim it before any await, so a double /q3 can't start two runs.
		const startedAt = Date.now();
		setDig(m, id, { state: "running", startedAt });
		if (m === st && q.status === "open") m.shown = pickShown(m.shown, m.questions, [id], startedAt, [id]);
		if (m === st) render(true);
		const model = DIG_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
		let tmpDir = "";
		try {
			const about = await fs.promises.readFile(ABOUT_FILE, "utf8").then(
				(s) => s.slice(0, 4000),
				() => "",
			);
			const { system, task } = buildDigPrompt({
				me: m.me,
				about,
				title: m.title,
				app: m.app,
				question: q,
				steer,
				lines: m.lines,
				clock: lineClock(m.lines.at(-1)),
			});
			tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-meeting-dig-"));
			const sysFile = path.join(tmpDir, "system.md");
			await fs.promises.writeFile(sysFile, system, { mode: 0o600 });
			const args = ["--mode", "json", "-p", "--no-session", ...(model ? ["--model", model] : [])];
			args.push("--thinking", DIG_THINKING, "--tools", DIG_TOOLS, "--append-system-prompt", sysFile, task);
			const inv = piInvocation(args);
			const proc = spawn(inv.cmd, inv.args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SUBAGENT_CHILD: "1" } });
			const run: DigRun = { m, id, proc, cancelled: false };
			digRuns.add(run);
			notify(`Researching Q${id}${model ? ` with ${model}` : ""}; the brief lands here within 3 min`);

			let final = "";
			let cost = 0;
			let buf = "";
			const stderr: string[] = [];
			const onLine = (line: string) => {
				let ev: { type?: string; message?: { role?: string; content?: { type: string; text?: string }[]; usage?: { cost?: { total?: number } } } };
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				const msg = ev.type === "message_end" ? ev.message : undefined;
				if (msg?.role !== "assistant") return;
				cost += msg.usage?.cost?.total ?? 0;
				const text = (msg.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
				if (text.trim()) final = text;
			};
			proc.stdout?.on("data", (d) => {
				buf += String(d);
				const parts = buf.split("\n");
				buf = parts.pop() ?? "";
				for (const l of parts) if (l.trim()) onLine(l);
			});
			proc.stderr?.on("data", (d) => stderr.push(String(d)));
			let timedOut = false;
			const killer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
			}, DIG_TIMEOUT_MS);
			const code = await new Promise<number>((resolve) => {
				proc.on("close", (c) => resolve(c ?? 1));
				proc.on("error", () => resolve(1));
			});
			clearTimeout(killer);
			if (buf.trim()) onLine(buf);
			digRuns.delete(run);
			if (run.cancelled) return;
			m.cost += cost;
			if (timedOut || !final.trim()) {
				const reason = stderr.join("").trim().split("\n").at(-1) || `exit ${code}`;
				const error = timedOut ? "timed out after 3 min" : reason.slice(0, 120);
				setDig(m, id, { state: "failed", startedAt, error });
				notify(`Q${id} research failed: ${error}`, "warning");
			} else {
				const brief = final.trim();
				const answer = briefAnswer(brief);
				setDig(m, id, { state: "done", startedAt, answer, brief });
				pi.sendMessage(
					{
						customType: MSG_TYPE,
						content: [`Meeting copilot · Q${id} research · ${mmssSince(startedAt)}${cost > 0 ? ` · $${cost.toFixed(3)}` : ""}`, `Q${id} ${q.q}`, brief].join("\n"),
						display: true,
						details: { kind: "research", id, answer, brief },
					},
					{ triggerTurn: false },
				);
				notify(`Q${id}: ${answer}`);
				// After the meeting the recap is already written; refresh it with the answer.
				if (m !== st) writeRecap(m);
			}
		} catch (e) {
			setDig(m, id, { state: "failed", startedAt, error: String((e as Error)?.message ?? e).slice(0, 120) });
			notify(`Q${id} research failed: ${(e as Error)?.message ?? e}`, "warning");
		} finally {
			if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			if (m === st) render(true);
		}
	}

	// /q3 isn't a registered command, so pi hands it to input handlers.
	pi.on("input", (event, ctx) => {
		const hit = parseDigInput(event.text);
		if (!hit) return { action: "continue" as const };
		ctxRef ??= ctx;
		void research(hit.id, hit.steer, ctx);
		return { action: "handled" as const };
	});

	pi.registerCommand("q", {
		description: "Research a meeting question with a subagent: /q 3 [what to look for], /q3, or /q to pick",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
			const m = st ?? last;
			const p = prefix.replace(/^q/i, "");
			return (m?.questions ?? [])
				.filter((q) => String(q.id).startsWith(p))
				.map((q) => ({ value: `${q.id} `, label: `Q${q.id}`, description: q.q.slice(0, 90) }));
		},
		handler: async (raw, ctx) => {
			ctxRef ??= ctx;
			const a = parseDigArgs(raw);
			if (a) return research(a.id, a.steer, ctx);
			const notify = (msg: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
			};
			if (raw.trim()) return notify("Usage: /q 3 [what to look for], /q3, or /q to pick", "warning");
			const m = st ?? last;
			if (!m?.questions.length) return notify("No meeting questions to research", "warning");
			if (!ctx.hasUI) return;
			const ordered = [...m.questions.filter((q) => q.status === "open"), ...m.questions.filter((q) => q.status !== "open")];
			const tag = (q: Question) => (q.dig?.state === "done" ? " 🔎✓" : q.dig?.state === "running" ? " 🔎" : q.status !== "open" ? ` (${q.status})` : "");
			const pick = await ctx.ui.select("Research which question?", ordered.map((q) => `Q${q.id}${tag(q)} ${q.q}`));
			const id = Number(/^Q(\d+)/.exec(pick ?? "")?.[1]);
			if (id) return research(id, "", ctx);
		},
	});

	// ── tick ──

	async function tick() {
		const m = st;
		if (!m || ticking) return;
		ticking = true;
		try {
			const now = Date.now();
			if (m.replay) {
				const r = m.replay;
				while (r.next < r.events.length && r.events[r.next]!.at - r.t0 <= (now - r.startedAt) * r.speed) {
					ingest(r.events[r.next++]!.ev, now, false);
				}
				if (r.next >= r.events.length && m.phase === "live") {
					m.phase = "ended";
					m.endedAt = now;
				}
			} else if (m.phase === "waiting") {
				const found = pickStartedSince(await listNames(), m.waitSince, { filter: m.filter });
				if (found) await attach(path.join(DIR, found), false);
			} else {
				await pollFile();
				if (m.phase === "ended") {
					const next = pickStartedSince(await listNames(), toStamp(m.endedAt - 60_000), { key: meetingKey(m.file) });
					if (next && path.join(DIR, next) !== m.file) await attach(path.join(DIR, next), false);
				}
			}
			if (st !== m) return;
			if (!m.busy) {
				const final = m.phase === "ended";
				if (m.forceNext || shouldFire(m.trig, now, final)) {
					m.forceNext = false;
					void check();
				} else if (final && m.trig.unsent === 0 && !digging(m)) {
					if (m.replay) return finish("replay finished");
					if (now - m.endedAt > RECONNECT_MS) return finish("meeting ended");
				}
			}
			// While a call has ended or research runs, redraw every tick so the timers move.
			render(m.phase === "ended" || digging(m));
		} catch (e) {
			if (st) st.error = String((e as Error)?.message ?? e).slice(0, 120);
		} finally {
			ticking = false;
		}
	}

	// ── command ──

	async function start(a: Args, ctx: ExtensionContext) {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		if (st) return notify("Meeting copilot is already running. /meeting stop first.", "warning");

		const registry = ctx.modelRegistry;
		const specs = a.model ? [a.model] : (process.env.PI_MEETING_MODEL || "").split(/[\s,]+/).filter((s) => s.includes("/"));
		const models = (specs.length ? specs : DEFAULT_MODELS)
			.map((spec) => registry.find(spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1)))
			.filter((m): m is Model<Api> => !!m && registry.hasConfiguredAuth(m));
		if (models.length === 0) return notify(`No meeting model with credentials (${(specs.length ? specs : DEFAULT_MODELS).join(", ")})`, "error");

		const me = process.env.PI_MEETING_ME || (await run("git", ["config", "--global", "--includes", "user.name"], 3000)).trim();
		const names = await listNames();
		let file = "";
		let live = false;
		if (a.target && (a.target.includes("/") || a.target.endsWith(".jsonl"))) {
			if (!fs.existsSync(a.target)) return notify(`No such file: ${a.target}`, "error");
			file = path.resolve(a.target);
		} else {
			const newest = pickNewest(names, a.target);
			if (newest) {
				const full = path.join(DIR, newest);
				const tail = await readTail(full, 4096);
				const fresh = Date.now() - (await fs.promises.stat(full)).mtimeMs < LIVE_STALE_MS;
				live = fresh && !tail.includes('"event":"stopped"');
				if (live || a.replay) file = full;
			}
		}
		if (a.replay && !file) return notify(`No transcript to replay${a.target ? ` matching "${a.target}"` : ""}`, "error");

		st = {
			phase: "waiting",
			filter: a.target,
			file: "",
			waitSince: toStamp(Date.now() - 60_000),
			offset: 0,
			partial: "",
			title: "",
			app: "",
			startedMs: 0,
			people: [],
			lines: [],
			sentUpTo: 0,
			trig: freshTrigger(),
			questions: [],
			shown: [],
			expanded: false,
			firstFile: "",
			nextId: 1,
			topic: "",
			reply: "",
			replyAt: 0,
			focus: "",
			wake: a.wake,
			me,
			meTokens: nameTokens(me),
			models,
			modelLabel: models.map((m) => m.name || m.id).join(" → "),
			system: "",
			sessionId: randomUUID(),
			checks: 0,
			cost: 0,
			busy: false,
			forceNext: false,
			error: "",
			endedAt: 0,
			lastRender: 0,
			lastNotify: 0,
			announced: false,
		};

		if (a.replay && file) {
			const events: { at: number; ev: MeetingEvent }[] = [];
			let at = 0;
			for (const raw of (await fs.promises.readFile(file, "utf8")).split("\n")) {
				const ev = raw.trim() ? parseEvent(raw) : null;
				if (!ev) continue;
				if (ev.kind === "line") at = Date.parse(ev.ts) || at;
				if (ev.kind === "meta" && ev.stopped) continue;
				events.push({ at, ev });
			}
			const t0 = events.find((e) => e.at > 0)?.at ?? 0;
			for (const e of events) if (!e.at) e.at = t0;
			st.file = file;
			st.firstFile = file;
			st.phase = "live";
			st.title = meetingKey(file);
			st.replay = { speed: a.replay, events, next: 0, t0, startedAt: Date.now() };
			// Metadata first so the title is real before the background search runs.
			while (st.replay.next < events.length && events[st.replay.next]!.ev.kind !== "line") ingest(events[st.replay.next++]!.ev, Date.now(), true);
			st.startedMs = Date.now();
			st.backgroundReady = buildBackground(file);
			st.announced = true;
			pi.sendMessage(
				{
					customType: MSG_TYPE,
					content: `Meeting copilot replaying "${st.title}" at ${a.replay}× via ${st.modelLabel}. Transcript: ${file.replace(/\.jsonl$/, ".txt")}. These updates are context for later; they need no reply.`,
					display: true,
					details: { kind: "start", file, replay: a.replay },
				},
				{ triggerTurn: false },
			);
		} else if (file) {
			await attach(file, true);
		} else {
			notify(`Meeting copilot waiting for a meeting${a.target ? ` matching "${a.target}"` : ""} to start`);
		}
		timer = setInterval(() => void tick(), POLL_MS);
		timer.unref?.();
		render(true);
	}

	pi.registerCommand("meeting", {
		description: "Live meeting copilot: suggested questions from the meeting-capture transcript",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			[
				{ value: "start", label: "start", description: "Attach to the live meeting, or wait for one: [filter|path] [--wake] [--replay N]" },
				{ value: "ask", label: "ask", description: "Check for questions right now" },
				{ value: "list", label: "list", description: "Show every question in the widget (again to collapse)" },
				{ value: "recap", label: "recap", description: "Post the recap so far and update the daily note" },
				{ value: "focus ", label: "focus", description: "Tell the scout what you want out of this meeting" },
				{ value: "stop", label: "stop", description: "Stop the copilot" },
			].filter((i) => i.value.startsWith(prefix)),
		handler: async (raw, ctx) => {
			ctxRef ??= ctx;
			const a = parseArgs(raw);
			const notify = (msg: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
			};
			switch (a.sub) {
				case "start":
					return start(a, ctx);
				case "stop":
					return st ? finish("/meeting stop") : void notify("Meeting copilot isn't running");
				case "ask":
					if (!st) return void notify("Meeting copilot isn't running. /meeting start", "warning");
					if (st.lines.length === 0) return void notify("Nothing in the transcript yet");
					st.forceNext = true;
					return void tick();
				case "focus":
					if (!st) return void notify("Meeting copilot isn't running. /meeting start", "warning");
					st.focus = a.rest;
					return void notify(a.rest ? `Meeting focus: ${a.rest}` : "Meeting focus cleared");
				case "list":
					if (!st) return void notify("Meeting copilot isn't running. /meeting start", "warning");
					st.expanded = !st.expanded;
					return void render(true);
				case "recap":
					if (!st) return void notify("Meeting copilot isn't running. /meeting start", "warning");
					return void postRecap(st, `Meeting copilot recap so far · ${st.title} · ${st.checks} checks`);
				default: {
					if (!st) return void notify("Meeting copilot is off. /meeting start [filter] [--wake] [--replay N]");
					const where = st.file ? path.basename(st.file) : `waiting${st.filter ? ` for "${st.filter}"` : ""}`;
					const open = st.questions.filter((q) => q.status === "open").length;
					return void notify(
						`Meeting copilot: ${where} · ${st.phase} · ${st.lines.length} lines · ${st.checks} checks · ${open} open, ${st.questions.length - open} answered or asked · ${st.modelLabel}${st.error ? ` · error: ${st.error}` : ""}`,
					);
				}
			}
		},
	});
}
