/**
 * Meeting copilot: transcript parsing, trigger cadence, scout replies, prompts,
 * file picking and the widget.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	applyUpdate,
	briefAnswer,
	buildDigPrompt,
	buildSystemPrompt,
	buildUserPrompt,
	clock,
	dailyNoteName,
	formatLine,
	freshTrigger,
	HOLD_MS,
	isCandidate,
	isInvite,
	isMe,
	meetingKey,
	mentionsMe,
	nameTokens,
	parseArgs,
	parseDigArgs,
	parseDigInput,
	parseEvent,
	parseScoutReply,
	pickNewest,
	pickShown,
	pickStartedSince,
	previousTranscript,
	recapBlock,
	recapBody,
	recapMarker,
	shouldFire,
	toStamp,
	TRIGGER,
	upsertRecap,
	widgetLines,
} from "../extensions/meeting.ts";

const plain = { fg: (_color, s) => s };
const Q = (id, overrides = {}) => ({ id, q: `question ${id}?`, why: "", at: 0, clock: "11:00", status: "open", ...overrides });

// ── parsing ──

test("parses meeting-capture records into events", () => {
	assert.deepEqual(
		parseEvent(
			'{"app":"Microsoft Teams","meeting":"EERT Weekly Sync","meeting_started_at":"2026-10-05T12:56:53-05:00","type":"metadata"}',
		),
		{ kind: "meta", title: "EERT Weekly Sync", app: "Microsoft Teams", startedAt: "2026-10-05T12:56:53-05:00", stopped: false },
	);
	assert.equal(parseEvent('{"duration":"00:32:14","event":"stopped","type":"metadata"}').stopped, true);
	assert.deepEqual(
		parseEvent('{"speaker":"Tabinda","text":"Most of  you\\ntomorrow.","ts":"2026-10-05T13:30:48-05:00","type":"caption"}'),
		{ kind: "line", ts: "2026-10-05T13:30:48-05:00", speaker: "Tabinda", text: "Most of you tomorrow.", chat: false },
	);
	assert.equal(parseEvent('{"speaker":"Alex Teal","text":"rofl","ts":"x","type":"chat"}').chat, true);
	assert.deepEqual(parseEvent('{"people":["A","B",3],"type":"people"}'), { kind: "people", people: ["A", "B"] });
});

test("drops records it can't use", () => {
	assert.equal(parseEvent("not json"), null);
	assert.equal(parseEvent('{"type":"caption","text":"   "}'), null);
	assert.equal(parseEvent('{"type":"window"}'), null);
});

test("lines keep the meeting's local clock time", () => {
	assert.equal(clock("2026-10-05T13:04:06-05:00"), "13:04:06");
	assert.equal(
		formatLine({ ts: "2026-10-05T13:04:06-05:00", speaker: "Alex Teal", text: "rofl", chat: true }),
		"[13:04:06] (chat) Alex Teal: rofl",
	);
});

test("names match across Teams' Last, First (ORG) format", () => {
	const me = nameTokens("Eric Boehs");
	assert.deepEqual(me, ["eric", "boehs"]);
	assert.ok(isMe("Boehs, Eric (ODDBALL)", me));
	assert.ok(isMe("Eric Boehs", me));
	assert.ok(!isMe("Eric Smith", me));
	assert.ok(!isMe("Anyone", []));
});

test("a mention needs the whole name part, not a substring", () => {
	const me = nameTokens("Eric Boehs");
	assert.ok(mentionsMe("Eric, what do you think?", me));
	assert.ok(mentionsMe("that's on boehs's list", me));
	assert.ok(!mentionsMe("across America", me));
	assert.ok(!mentionsMe("generic numeric stuff", me));
});

test("recognizes an invitation for questions", () => {
	assert.ok(isInvite("OK, any questions before we move on?"));
	assert.ok(isInvite("Thoughts?"));
	assert.ok(!isInvite("I had questions about the runner yesterday"));
});

// ── triggers ──

test("nothing new, nothing to do", () => {
	assert.equal(shouldFire(freshTrigger(), 1_000_000), null);
});

test("a batch of lines waits for a pause and the minimum gap", () => {
	const now = 1_000_000;
	const t = { unsent: TRIGGER.batch, firstUnsentAt: now - 10_000, lastLineAt: now - 3_000, lastCallAt: now - 20_000, cue: null };
	assert.equal(shouldFire(t, now), "batch");
	assert.equal(shouldFire({ ...t, lastLineAt: now - 500 }, now), null, "still talking");
	assert.equal(shouldFire({ ...t, lastCallAt: now - 5_000 }, now), null, "checked too recently");
	assert.equal(shouldFire({ ...t, unsent: 2 }, now), null, "too few lines");
});

test("a trickle fires once it has waited long enough", () => {
	const now = 1_000_000;
	const t = { unsent: 2, firstUnsentAt: now - TRIGGER.maxWaitMs, lastLineAt: now - 3_000, lastCallAt: now - 60_000, cue: null };
	assert.equal(shouldFire(t, now), "batch");
});

test("a flood fires without waiting for a pause", () => {
	const now = 1_000_000;
	const t = { unsent: TRIGGER.flood, firstUnsentAt: now - 1_000, lastLineAt: now, lastCallAt: now - 20_000, cue: null };
	assert.equal(shouldFire(t, now), "batch");
});

test("a cue skips the batch size and the gap, but lets the sentence land", () => {
	const now = 1_000_000;
	const t = { unsent: 1, firstUnsentAt: now - 2_000, lastLineAt: now - 2_000, lastCallAt: now - 1_000, cue: "mention" };
	assert.equal(shouldFire(t, now), "cue");
	assert.equal(shouldFire({ ...t, lastLineAt: now - 100 }, now), null);
});

test("a cue never holds back a flood", () => {
	const now = 1_000_000;
	const t = { unsent: TRIGGER.flood, firstUnsentAt: now - 5_000, lastLineAt: now, lastCallAt: now - 20_000, cue: "mention" };
	assert.equal(shouldFire(t, now), "batch");
});

test("once the meeting is over, any leftover lines get a look", () => {
	const now = 1_000_000;
	const t = { unsent: 1, firstUnsentAt: now - 5_000, lastLineAt: now - 5_000, lastCallAt: now - 20_000, cue: null };
	assert.equal(shouldFire(t, now), null);
	assert.equal(shouldFire(t, now, true), "batch");
});

// ── scout replies ──

test("reads the scout's JSON through fences and prose", () => {
	const u = parseScoutReply(
		'Sure:\n```json\n{"topic":"runner migration","add":[{"q":"Who owns the image rebuild?","why":"no owner named"}],"closed":[{"id":"Q2","by":"asked","note":""},{"id":3,"by":"answered","note":"Kyle: Friday"}],"top":["Q4",1],"reply":""}\n```',
	);
	assert.deepEqual(u, {
		topic: "runner migration",
		add: [{ q: "Who owns the image rebuild?", why: "no owner named" }],
		closed: [
			{ id: 2, by: "asked", note: "" },
			{ id: 3, by: "answered", note: "Kyle: Friday" },
		],
		top: [4, 1],
		reply: "",
	});
});

test("tolerates loose shapes and rejects non-JSON", () => {
	const u = parseScoutReply('{"add":["Is Friday firm?", {"question":"Who signs off?"}], "closed":[5, "Q6"], "drop":[1]}');
	assert.deepEqual(u.add, [
		{ q: "Is Friday firm?", why: "" },
		{ q: "Who signs off?", why: "" },
	]);
	assert.deepEqual(u.closed, [
		{ id: 5, by: "answered", note: "" },
		{ id: 6, by: "answered", note: "" },
	]);
	assert.deepEqual(u.top, [], "no top, no ranking");
	assert.equal(parseScoutReply("no questions right now"), null);
	assert.equal(parseScoutReply("{broken"), null);
});

const update = (overrides = {}) => ({ topic: "", add: [], closed: [], top: [], reply: "", ...overrides });

test("an update closes what was answered and adds the rest, deduped against everything", () => {
	const qs = [Q(1, { q: "Is Friday firm?" }), Q(2, { q: "Who signs off?", status: "answered" })];
	const r = applyUpdate(
		qs,
		update({
			add: [{ q: "who signs off", why: "" }, { q: "Does CSOC need a ticket?", why: "Kyle said pending" }],
			closed: [{ id: 1, by: "answered", note: "Teal: yes, Friday" }, { id: 2, by: "asked", note: "" }],
		}),
		3,
		1000,
		"11:05",
		2,
	);
	assert.deepEqual(r.closed, [{ ...qs[0], status: "answered", closedClock: "11:05", note: "Teal: yes, Friday" }]);
	assert.equal(r.questions[1].status, "answered", "an already-closed question stays as it was");
	assert.deepEqual(r.added, [{ id: 3, q: "Does CSOC need a ticket?", why: "Kyle said pending", at: 1000, clock: "11:05", status: "open" }]);
	assert.equal(r.questions.length, 3);
	assert.equal(r.nextId, 4);
});

test("no question leaves the list unless it's closed", () => {
	const qs = [1, 2, 3, 4, 5].map((id) => Q(id));
	const r = applyUpdate(qs, update({ add: [{ q: "one more", why: "" }, { q: "and another", why: "" }] }), 6, 0);
	assert.deepEqual(r.questions.map((q) => q.id), [1, 2, 3, 4, 5, 6], "one add per update by default");
	assert.ok(r.questions.every((q) => q.status === "open"));
});

test("the widget shows new questions first, then the scout's ranking, then the newest", () => {
	const qs = [1, 2, 3, 4, 5].map((id) => Q(id));
	assert.deepEqual(pickShown([], qs, [], 0).map((s) => s.id), [3, 4, 5]);
	assert.deepEqual(pickShown([], qs, [2, 1], 0).map((s) => s.id), [1, 2, 5]);
});

test("a re-ranked question waits for a shown one to have had its time", () => {
	const qs = [1, 2, 3, 4].map((id) => Q(id));
	const shown = [1, 2, 3].map((id) => ({ id, since: 0 }));
	assert.deepEqual(pickShown(shown, qs, [4], HOLD_MS - 1).map((s) => s.id), [1, 2, 3], "Q4 waits");
	const later = pickShown(shown, qs, [4, 1, 2], HOLD_MS);
	assert.deepEqual(later.map((s) => s.id), [1, 2, 4], "Q4 takes the worst-ranked slot");
	assert.equal(later.find((s) => s.id === 4).since, HOLD_MS);
	assert.equal(later.find((s) => s.id === 1).since, 0, "kept questions keep their clock");
});

test("a new question shows at once, bumping one past its hold if there is one", () => {
	const qs = [1, 2, 3, 4].map((id) => Q(id));
	const young = [1, 2, 3].map((id) => ({ id, since: 1000 }));
	assert.deepEqual(pickShown(young, qs, [4], 2000, [4]).map((s) => s.id), [2, 3, 4], "the worst-ranked young one goes");
	const mixed = [{ id: 1, since: 1000 }, { id: 2, since: 0 }, { id: 3, since: 1000 }];
	assert.deepEqual(pickShown(mixed, qs, [4, 1], HOLD_MS, [4]).map((s) => s.id), [1, 3, 4], "Q2 had its time");
});

test("an answered question frees its slot at once", () => {
	const qs = [Q(1, { status: "answered" }), Q(2), Q(3), Q(4)];
	const shown = [1, 2, 3].map((id) => ({ id, since: 0 }));
	assert.deepEqual(pickShown(shown, qs, [4], 10).map((s) => s.id), [2, 3, 4]);
});

// ── prompts ──

const promptInput = (overrides = {}) => ({
	title: "EERT Weekly Sync",
	app: "Microsoft Teams",
	people: ["Alex Teal", "Eric Boehs"],
	lines: ["[13:00:00] Alex Teal: Runner cutover is Friday.", "[13:00:05] Kyle: Pending CSOC."],
	newFrom: 0,
	open: [],
	focus: "",
	cue: null,
	me: "Eric Boehs",
	now: new Date(2026, 9, 5, 13, 0, 10),
	...overrides,
});

test("the first look says so; later looks point at the new lines", () => {
	assert.match(buildUserPrompt(promptInput()), /This is your first look\./);
	const later = buildUserPrompt(
		promptInput({
			newFrom: 1,
			open: [Q(4, { q: "Is Friday firm?", why: "no date set" })],
			closed: [Q(2, { q: "Who signs off?", status: "answered" })],
		}),
	);
	assert.match(later, /New since your last update: the lines from \[13:00:05\] Kyle/);
	assert.match(later, /Q4: Is Friday firm\? \(no date set\)/);
	assert.match(later, /Already answered or asked \(don't add again\):\nQ2: Who signs off\?/);
	assert.doesNotMatch(buildUserPrompt(promptInput()), /Already answered/);
});

test("the transcript comes before anything that changes between calls", () => {
	const p = buildUserPrompt(promptInput({ focus: "push for a cutover date", cue: "mention" }));
	assert.ok(p.indexOf("</transcript>") < p.indexOf("Now:"));
	assert.ok(p.indexOf("</transcript>") < p.indexOf("goals for this meeting"));
	assert.match(p, /Eric Boehs was just named/);
});

test("a very long transcript keeps its tail", () => {
	const lines = Array.from({ length: 3000 }, (_, i) => `[13:00:00] A: line ${i} ${"x".repeat(40)}`);
	const p = buildUserPrompt(promptInput({ lines, newFrom: 2999 }));
	assert.match(p, /earlier lines omitted/);
	assert.match(p, /line 2999 /);
	assert.doesNotMatch(p, /line 0 /);
});

test("the system prompt carries the rules, the JSON shape and the background", () => {
	const s = buildSystemPrompt("Eric Boehs", "Engineer on EERT.", "## Notes\n- runner");
	assert.match(s, /live meeting copilot for Eric Boehs/);
	assert.match(s, /"add": \[\{"q"/);
	assert.match(s, /"closed": \[\{"id": 1, "by": "answered"/);
	assert.match(s, /Never close a question just because the conversation moved on/);
	assert.match(s, /<about>\nEngineer on EERT\.\n<\/about>/);
	assert.match(s, /<background>\n## Notes/);
	assert.doesNotMatch(buildSystemPrompt("", "", ""), /<about>|<background>/);
});

// ── files ──

test("meeting keys and candidates", () => {
	assert.equal(meetingKey("20261005_125906-teams-eert-weekly-sync.jsonl"), "teams-eert-weekly-sync");
	assert.equal(meetingKey("/x/20261005_125906-teams-eert-weekly-sync.txt"), "teams-eert-weekly-sync");
	assert.ok(isCandidate("20261005_125906-teams-eert-weekly-sync.jsonl"));
	assert.ok(!isCandidate("20261005_125906-teams-eert-weekly-sync.txt"));
	assert.ok(!isCandidate("20261005_125906-slack-notifications-x.jsonl"));
	assert.ok(!isCandidate("20261005_125906-teams-test-run.jsonl"));
	assert.ok(!isCandidate("20261005_125906-teams-standup-merged.jsonl"));
});

const names = [
	"20261001_143050-teams-eric-tabinda.jsonl",
	"20261002_070140-teams-2026-va-daily-it-stand-up-briefing.jsonl",
	"20261005_125906-teams-eert-weekly-sync.jsonl",
	"20261005_125906-teams-eert-weekly-sync.txt",
	"20261005_140000-slack-notifications-x.jsonl",
];

test("picks the newest capture, optionally by name", () => {
	assert.equal(pickNewest(names), "20261005_125906-teams-eert-weekly-sync.jsonl");
	assert.equal(pickNewest(names, "Tabinda"), "20261001_143050-teams-eric-tabinda.jsonl");
	assert.equal(pickNewest(names, "nope"), undefined);
});

test("only captures started since the wait began count", () => {
	assert.equal(pickStartedSince(names, "20261005_120000"), "20261005_125906-teams-eert-weekly-sync.jsonl");
	assert.equal(pickStartedSince(names, "20261005_130000"), undefined);
	assert.equal(pickStartedSince(names, "20261001_000000", { key: "teams-eric-tabinda" }), "20261001_143050-teams-eric-tabinda.jsonl");
});

test("the previous transcript is the biggest file from the last earlier day", () => {
	const files = [
		{ name: "20260921_125900-teams-eert-weekly-sync.txt", size: 30_000 },
		{ name: "20260928_125900-teams-eert-weekly-sync.txt", size: 2_000 },
		{ name: "20260928_130500-teams-eert-weekly-sync.txt", size: 25_000 },
		{ name: "20260928_131000-teams-eert-weekly-sync.txt", size: 200 },
		{ name: "20261005_120000-teams-eert-weekly-sync.txt", size: 50_000 },
		{ name: "20260930_125900-teams-other.txt", size: 90_000 },
	];
	assert.equal(previousTranscript(files, "20261005_125906-teams-eert-weekly-sync.jsonl"), "20260928_130500-teams-eert-weekly-sync.txt");
	assert.equal(previousTranscript(files, "20260921_125900-teams-eert-weekly-sync.jsonl"), undefined);
});

test("filename stamps use local time", () => {
	assert.equal(toStamp(new Date(2026, 9, 5, 7, 3, 9).getTime()), "20261005_070309");
});

// ── args ──

test("parses subcommands, flags and targets", () => {
	assert.deepEqual(parseArgs(""), { sub: "status", target: "", rest: "", wake: false });
	assert.equal(parseArgs("stop").sub, "stop");
	assert.deepEqual(parseArgs("focus push for a cutover date"), { sub: "focus", target: "", rest: "push for a cutover date", wake: false });
	const a = parseArgs("start eert --wake --model inco/deepseek-v4.1-flash:fast --replay 20");
	assert.deepEqual([a.sub, a.target, a.wake, a.model, a.replay], ["start", "eert", true, "inco/deepseek-v4.1-flash:fast", 20]);
	assert.equal(parseArgs("start --replay").replay, 10);
	assert.equal(parseArgs("start --replay eert").target, "eert");
	assert.equal(parseArgs("eert").sub, "start", "a bare filter means start");
	assert.equal(parseArgs("start ~/x.jsonl").target, `${os.homedir()}/x.jsonl`);
	assert.equal(parseArgs("list").sub, "list");
	assert.equal(parseArgs("expand").sub, "list");
	assert.equal(parseArgs("recap").sub, "recap");
});

// ── research ──

test("/q3 and /q 3 name a question, with optional steering", () => {
	assert.deepEqual(parseDigInput("/q3"), { id: 3, steer: "" });
	assert.deepEqual(parseDigInput("  /Q12 check the ATO docs \n"), { id: 12, steer: "check the ATO docs" });
	assert.equal(parseDigInput("/q"), null);
	assert.equal(parseDigInput("/quit"), null);
	assert.equal(parseDigInput("what about /q3"), null);
	assert.deepEqual(parseDigArgs("3"), { id: 3, steer: "" });
	assert.deepEqual(parseDigArgs("Q3 who owns it"), { id: 3, steer: "who owns it" });
	assert.equal(parseDigArgs(""), null);
	assert.equal(parseDigArgs("three"), null);
});

test("the brief's Answer line is the one-liner", () => {
	assert.equal(briefAnswer("Answer: Kyle's team owns DR, per the Sept runbook\n- runbook.md\nAsk: ..."), "Kyle's team owns DR, per the Sept runbook");
	assert.equal(briefAnswer("**Answer:** Not found\n- searched Slack"), "Not found");
	assert.equal(briefAnswer("\nNo answer line here\nmore"), "No answer line here");
	assert.equal(briefAnswer(`Answer: ${"x".repeat(300)}`).length, 160);
	const long = briefAnswer(`Answer: ${"milestone one closes on discovery, ".repeat(8)}`);
	assert.ok(long.length <= 160 && / (milestone|one|closes|on|discovery)…$/.test(long), `cut mid-word: ${long}`);
});

test("a research subagent gets the question, why, steer, background and the transcript tail", () => {
	const lines = Array.from({ length: 400 }, (_, i) => `[11:${String(i % 60).padStart(2, "0")}] Kyle: line ${i} ${"words ".repeat(5)}`);
	const { system, task } = buildDigPrompt({
		me: "Eric Boehs",
		about: "I work on EERT.",
		title: "EI: Cloud Config",
		app: "teams",
		question: Q(3, { q: "How did 97 systems pass ATO with no DR?", why: "0/97 with DR" }),
		steer: "check eMASS notes",
		lines,
		clock: "11:39",
	});
	assert.match(system, /Return only the brief/);
	assert.match(system, /under 3 minutes/);
	assert.match(system, /Read only/);
	assert.match(system, /qmd search/);
	assert.match(system, /^Answer: /m);
	assert.match(task, /^Meeting: EI: Cloud Config \(teams\) · now 11:39$/m);
	assert.match(task, /^Research Q3: How did 97 systems pass ATO with no DR\?$/m);
	assert.match(task, /^Why it came up: 0\/97 with DR$/m);
	assert.match(task, /^Eric Boehs adds: check eMASS notes$/m);
	assert.match(task, /<about>\nI work on EERT\.\n<\/about>/);
	assert.ok(task.includes("line 399"), "keeps the latest lines");
	assert.ok(!task.includes("line 0 "), "drops the oldest");
	assert.ok(task.length < 9000, `${task.length} chars`);
});

// ── recap ──

const meetingQs = [
	Q(1, { q: "Who picks the candidate systems?", status: "answered", note: "Kyle's team, by Friday", clock: "11:09", closedClock: "11:13" }),
	Q(2, { q: "Is the explainer due this week?", status: "asked", clock: "11:10", closedClock: "11:10" }),
	Q(3, { q: "How did 97 systems pass ATO with no DR recorded?", why: "Eric found 0/97 with DR", clock: "11:17" }),
];

test("the recap groups every question by outcome", () => {
	assert.deepEqual(recapBody(meetingQs), [
		"Still open (never asked):",
		"- Q3 How did 97 systems pass ATO with no DR recorded? (11:17; Eric found 0/97 with DR)",
		"",
		"Answered:",
		"- Q1 Who picks the candidate systems? → Kyle's team, by Friday (11:09–11:13)",
		"",
		"Asked:",
		"- Q2 Is the explainer due this week? (11:10)",
	]);
	assert.deepEqual(recapBody([]), ["No questions came up."]);
});

test("a researched question carries its answer into the recap", () => {
	const qs = [...meetingQs];
	qs[2] = { ...qs[2], dig: { state: "done", startedAt: 0, answer: "Inherited from the GovCloud package" } };
	qs[1] = { ...qs[1], dig: { state: "failed", startedAt: 0, error: "timed out" } };
	const body = recapBody(qs);
	assert.deepEqual(body.slice(0, 3), [
		"Still open (never asked):",
		"- Q3 How did 97 systems pass ATO with no DR recorded? (11:17; Eric found 0/97 with DR)",
		"  - Researched: Inherited from the GovCloud package",
	]);
	assert.ok(!body.some((l) => l.includes("timed out")), "a failed run leaves no trace");
});

const file = `${os.homedir()}/.local/share/meeting-capture/20261006_110421-teams-ei-cloud-config.jsonl`;
const block = recapBlock({ title: "EI: Cloud Config", file, from: "11:04", to: "11:20", checks: 14, questions: meetingQs });
const marker = recapMarker(file);

test("the daily-note block has a heading, a hidden marker and the transcript", () => {
	const lines = block.split("\n");
	assert.equal(lines[0], "### 11:04–11:20 EI: Cloud Config · copilot questions");
	assert.equal(lines[1], "<!-- meeting-copilot:20261006_110421-teams-ei-cloud-config -->");
	assert.equal(lines[2], "Transcript: `~/.local/share/meeting-capture/20261006_110421-teams-ei-cloud-config.txt` · 14 checks");
	assert.equal(dailyNoteName(file), "2026-10-06.md");
	assert.equal(dailyNoteName("/tmp/x.jsonl", new Date(2026, 0, 2)), "2026-01-02.md");
});

const note = [
	"# Tue",
	"",
	"## Meetings",
	"",
	"| Time | Meeting |",
	"|---|---|",
	"| 11:05 | EI: Cloud Config |",
	"",
	"",
	"## Standup",
	"",
	"- shipped",
	"",
].join("\n");

test("the recap goes at the end of ## Meetings and leaves the rest alone", () => {
	const out = upsertRecap(note, block, marker);
	const [before, after] = out.split(block);
	assert.equal(before, "# Tue\n\n## Meetings\n\n| Time | Meeting |\n|---|---|\n| 11:05 | EI: Cloud Config |\n\n");
	assert.equal(after, "\n\n## Standup\n\n- shipped\n");
});

test("writing the recap again replaces it in place", () => {
	const once = upsertRecap(note, block, marker);
	const newer = block.replace("14 checks", "15 checks");
	const twice = upsertRecap(once, newer, marker);
	assert.equal(twice, once.replace("14 checks", "15 checks"));
	assert.equal(twice.split(marker).length, 2, "one block");
	assert.equal(upsertRecap(twice, newer, marker), twice, "idempotent");
});

test("two meetings stack under the heading; a note without one gets the section", () => {
	const other = recapBlock({ title: "Fraud sync", file: "/x/20261006_140500-teams-fraud.jsonl", from: "14:05", to: "14:30", checks: 3, questions: [] });
	const both = upsertRecap(upsertRecap(note, block, marker), other, recapMarker("/x/20261006_140500-teams-fraud.jsonl"));
	assert.ok(both.indexOf("EI: Cloud Config · copilot") < both.indexOf("Fraud sync · copilot"));
	assert.ok(both.indexOf("Fraud sync · copilot") < both.indexOf("## Standup"));
	assert.equal(upsertRecap("# Tue\n\nnotes", "### x", "m"), "# Tue\n\nnotes\n\n## Meetings\n\n### x\n");
	assert.equal(upsertRecap("", "### x", "m"), "## Meetings\n\n### x\n");
});

// ── widget ──

const view = (overrides = {}) => ({
	phase: "live",
	title: "EERT Weekly Sync",
	filter: "",
	startedMs: 0,
	topic: "runner migration",
	checks: 3,
	cost: 0,
	busy: false,
	error: "",
	questions: [],
	shown: [],
	expanded: false,
	reply: "",
	replay: false,
	endsAt: 0,
	...overrides,
});

test("waiting shows one line", () => {
	assert.deepEqual(widgetLines(view({ phase: "waiting", filter: "eert" }), plain, 120), [
		'◌ meeting · waiting for a meeting matching "eert" · /meeting stop',
	]);
});

test("live shows the header, the shown questions, what's hidden, and a reply", () => {
	const now = 1_000_000_000;
	const lines = widgetLines(
		view({
			startedMs: now - 16 * 60_000,
			questions: [Q(1), Q(2, { status: "answered" }), Q(3, { q: "Is the Friday cutover still blocked on CSOC?", why: "Kyle said pending" }), Q(4)],
			shown: [3],
			reply: "Yes, PR is up and waiting on review.",
		}),
		plain,
		120,
		now,
	);
	assert.deepEqual(lines, [
		"● meeting · EERT Weekly Sync · 16m · runner migration · 3 checks · /meeting stop",
		"  Q3 Is the Friday cutover still blocked on CSOC? — Kyle said pending",
		"  +2 more open · 1 answered or asked · /meeting list",
		"  ↳ say: Yes, PR is up and waiting on review.",
	]);
});

test("expanded lists every question, open first", () => {
	const lines = widgetLines(
		view({ expanded: true, shown: [3], questions: [Q(1), Q(2, { status: "answered", note: "Friday" }), Q(3), Q(4, { status: "asked" })] }),
		plain,
		120,
	);
	assert.deepEqual(lines.slice(1), [
		"  Q1 question 1?",
		"  Q3 question 3?",
		"  ✓ Q2 question 2? → Friday",
		"  ✓ Q4 question 4? (asked)",
		"  /meeting list to collapse",
	]);
});

test("expanded stays bounded however long the meeting runs", () => {
	const questions = Array.from({ length: 40 }, (_, i) => Q(i + 1, { status: i < 25 ? "answered" : "open" }));
	const lines = widgetLines(view({ expanded: true, questions }), plain, 120);
	assert.ok(lines.length <= 21, `${lines.length} lines`);
	assert.ok(lines.includes("  Q40 question 40?"), "every open question fits here");
	assert.ok(lines.some((l) => /✓ \d+ more answered or asked · \/meeting recap/.test(l)));
});

test("an ended call counts down to the stop", () => {
	const now = 1_000_000;
	const head = (v) => widgetLines(view({ phase: "ended", ...v }), plain, 200, now)[0];
	assert.match(head({ endsAt: now + 72_000 }), / · call ended · stopping in 1:12 unless it resumes · /);
	assert.match(head({ endsAt: now - 1 }), / · call ended · /);
	assert.match(head({ replay: true }), / · replay done · /);
});

test("research shows a timer while it runs and the answer once it lands", () => {
	const now = 1_000_000;
	const lines = widgetLines(
		view({
			questions: [
				Q(1, { dig: { state: "running", startedAt: now - 80_000 } }),
				Q(2, { dig: { state: "done", startedAt: 0, answer: "Kyle's team, per the runbook" } }),
				Q(3, { dig: { state: "failed", startedAt: 0, error: "x" } }),
			],
			shown: [1, 2, 3],
		}),
		plain,
		120,
		now,
	);
	assert.deepEqual(lines.slice(1), [
		"  Q1 🔎 1:20 question 1?",
		"  Q2 🔎✓ question 2?",
		"    → Kyle's team, per the runbook",
		"  Q3 🔎✕ question 3?",
	]);
	const ended = (v) => widgetLines(view({ phase: "ended", questions: [Q(1, { dig: { state: "running", startedAt: now } })], ...v }), plain, 200, now)[0];
	assert.match(ended({ endsAt: now - 1 }), / · call ended · finishing research · /);
	assert.match(ended({ replay: true }), / · replay done · finishing research · /);
	assert.match(ended({ endsAt: now + 5000 }), /stopping in 0:05/, "the countdown still shows first");
});

test("every widget line fits the width", () => {
	const lines = widgetLines(view({ questions: [Q(1, { q: "a long question ".repeat(12), why: "because ".repeat(6) })], shown: [1], busy: true }), plain, 40);
	assert.ok(lines.length > 2);
	for (const l of lines) assert.ok(visibleWidth(l) <= 40, `too wide: ${JSON.stringify(l)}`);
	assert.match(lines[0], /^◐ /);
});
