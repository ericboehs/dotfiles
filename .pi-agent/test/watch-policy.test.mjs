/**
 * watch/policy.ts and watch/prep.ts: nudges, candidates, decide() and its
 * gates, the budget, ignored offers, quiet and loud, and the ical agenda.
 *
 *   node --test .pi-agent/test/watch-policy.test.mjs
 *
 * All people, meetings and messages here are made up.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	awayCases,
	awayIdleSec,
	decide,
	gate,
	isMissedCall,
	isQuiet,
	markFired,
	newPolicy,
	noteIgnored,
	noteTaken,
	nudgeOf,
	offerCase,
	parseBudget,
	parseHidIdle,
	parsePersonArgs,
	prepCase,
	pushLog,
	recordAct,
	rollPolicy,
	routeOk,
	setLoud,
	setQuiet,
	urgentCase,
	wakesText,
	workHoursAt,
} from "../extensions/watch/policy.ts";
import { icalTime, parseAgenda, skipPattern, workCalendarIds } from "../extensions/watch/prep.ts";

const NOW = Date.parse("2026-10-06T14:00:00-05:00"); // a Tuesday
const sec = (ms) => String(ms / 1000);

function item(over = {}) {
	return {
		key: over.key ?? "oddball:D1:1",
		ts: sec(NOW - 5 * 60_000),
		workspace: "oddball",
		channel: "D1",
		where: "oddball DM",
		from: "Kim Lee",
		kind: "dm",
		text: "When is the ATO date?",
		why: "ATO date?",
		bucket: "needs",
		state: "open",
		...over,
	};
}

const view = (over = {}) => ({
	now: NOW,
	nowIso: "2026-10-06T14:00:00-05:00",
	meeting: false,
	workHours: true,
	idle: true,
	pending: false,
	editorText: false,
	lastInputAt: NOW - 10 * 60_000,
	sessionWork: true,
	actsToday: 0,
	lastActAt: 0,
	perDay: 12,
	gapMs: 15 * 60_000,
	quiet: () => false,
	...over,
});

const noVip = () => false;
const routeOf = (ws) => (ws === "dsva" ? "work" : "personal");

// ── nudges ──

test("nudges: urgent words, 3 pings in 30 minutes, a VIP; nothing for plain DMs or threads", () => {
	assert.equal(nudgeOf(item(), [], noVip), "");
	assert.equal(nudgeOf(item({ text: "this is a blocker, need it ASAP" }), [], noVip), "urgent");
	assert.equal(nudgeOf(item({ kind: "mention", text: "urgent: anyone?" }), [], noVip), "", "urgent in a channel needs a VIP");
	assert.equal(nudgeOf(item({ kind: "mention", text: "urgent", from: "Alex Teal" }), [], (w) => w === "Alex Teal"), "urgent");
	assert.equal(nudgeOf(item({ from: "Alex Teal" }), [], (w) => w === "Alex Teal"), "VIP DM");
	assert.equal(nudgeOf(item({ kind: "thread", text: "urgent" }), [], noVip), "", "threads never nudge");
	const pings = [1, 2].map((k) => item({ key: `p${k}`, ts: sec(NOW - k * 10 * 60_000) }));
	assert.equal(nudgeOf(item(), pings, noVip), "3 pings in 30 min");
	const old = [1, 2].map((k) => item({ key: `o${k}`, ts: sec(NOW - k * 40 * 60_000) }));
	assert.equal(nudgeOf(item(), old, noVip), "", "spread over more than 30 minutes");
	assert.equal(nudgeOf(item(), [item(), item()], noVip), "", "the same item twice is one ping");
});

test("missed calls: Phone or FaceTime, by the word missed", () => {
	assert.ok(isMissedCall("Phone", "Missed Call", "Alex Teal"));
	assert.ok(isMissedCall("FaceTime", "Alex Teal", "Missed FaceTime Audio"));
	assert.ok(!isMissedCall("Phone", "Alex Teal", "Incoming call"));
	assert.ok(!isMissedCall("Messages", "Missed you", "lol"));
});

// ── candidates ──

test("offers: open needs items with a scout offer, gone once fired or 4 hours old", () => {
	const c = offerCase(item({ offer: "draft", offerWhy: "draft from the ATO notes" }), "personal", new Set(), NOW);
	assert.deepEqual(
		{ key: c.key, offer: c.offer, who: c.who, what: c.what, ws: c.workspace, case: c.case },
		{ key: "oddball:D1:1", offer: { kind: "draft", why: "draft from the ATO notes" }, who: "Kim Lee", what: "Kim · ATO date?", ws: "oddball", case: undefined },
	);
	assert.equal(offerCase(item(), "personal", new Set(), NOW), null, "no offer from the scout");
	assert.equal(offerCase(item({ offer: "look", state: "cleared" }), "personal", new Set(), NOW), null);
	assert.equal(offerCase(item({ offer: "look" }), "personal", new Set(["oddball:D1:1"]), NOW), null);
	assert.equal(offerCase(item({ offer: "look", ts: sec(NOW - 5 * 3600_000) }), "personal", new Set(), NOW), null);
});

test("urgent: one candidate for the conversation, with every open ping from them", () => {
	const a = item({ key: "a", nudge: "urgent" });
	const b = item({ key: "b" });
	const other = item({ key: "c", from: "Ben Carter" });
	const c = urgentCase(a, [a, b, other], "personal", new Set(), NOW);
	assert.equal(c.key, "urgent:oddball:D1:");
	assert.equal(c.case, "urgent");
	assert.deepEqual(c.items.map((i) => i.key), ["a", "b"]);
	assert.equal(urgentCase(item({ nudge: "VIP DM" }), [], "personal", new Set(), NOW), null, "a VIP DM nudges but does not act");
	assert.equal(urgentCase(a, [], "personal", new Set([c.key]), NOW), null, "once each conversation and day");
	assert.equal(urgentCase(item({ nudge: "urgent", ts: sec(NOW - 5 * 3600_000) }), [], "personal", new Set(), NOW), null, "not a stale backlog item");
});

test("away: after 20 minutes idle, one candidate each workspace for the open draft offers", () => {
	const needs = [
		item({ key: "a", offer: "draft" }),
		item({ key: "b", offer: "draft", from: "Ben Carter" }),
		item({ key: "c", offer: "draft", workspace: "dsva", where: "dsva DM" }),
		item({ key: "d", offer: "look" }),
		item({ key: "e", offer: "draft", kind: "thread" }),
	];
	assert.deepEqual(awayCases(needs, 19 * 60, new Set(), routeOf), []);
	const cs = awayCases(needs, 21 * 60, new Set(["b"]), routeOf);
	assert.deepEqual(
		cs.map((c) => [c.key, c.route, c.workspace, c.who, c.what]),
		[
			["away:a", "personal", "oddball", "Kim Lee", "1 question"],
			["away:c", "work", "dsva", "Kim Lee", "1 question"],
		],
	);
	const two = awayCases(needs.slice(0, 2), 30 * 60, new Set(), routeOf)[0];
	assert.equal(two.who, "Kim, Ben");
	assert.equal(two.what, "2 questions");
	assert.equal(decide(two, view()).what, "away · 2 questions", "decisions name the case once");
});

test("away time: HID idle, capped by the last pi input (pi over SSH never moves the HID clock)", () => {
	assert.equal(awayIdleSec(17_294, NOW - 30_000, NOW), 30, "typing over SSH: not away");
	assert.equal(awayIdleSec(25 * 60, NOW - 3600_000, NOW), 25 * 60, "at the Mac but not in pi: HID decides");
	assert.equal(awayIdleSec(null, NOW - 3600_000, NOW), 0, "no HID reading: never away on a guess");
	assert.equal(awayIdleSec(60, NOW + 5_000, NOW), 0);
});

test("prep: a work meeting 10 minutes out or less, once each meeting and day", () => {
	const m = { key: "prep:E1:2026-10-06", id: "E1", title: "Platform Sync", start: new Date(NOW + 8 * 60_000).toISOString(), who: ["Alex Teal", "Kim Lee"] };
	const c = prepCase(m, NOW, new Set(), "dsva");
	assert.equal(c.case, "prep");
	assert.equal(c.route, "work");
	assert.equal(c.workspace, "dsva");
	assert.match(c.what, /^Platform Sync 14:08$/);
	assert.equal(prepCase({ ...m, start: new Date(NOW + 12 * 60_000).toISOString() }, NOW, new Set(), "dsva"), null, "too early");
	assert.equal(prepCase({ ...m, start: new Date(NOW - 60_000).toISOString() }, NOW, new Set(), "dsva"), null, "already started");
	assert.equal(prepCase(m, NOW, new Set([m.key]), "dsva"), null);
});

// ── decide ──

const offer = () => offerCase(item({ offer: "draft" }), "personal", new Set(), NOW);
const away = (over = {}) => ({ ...awayCases([item({ offer: "draft" })], 1800, new Set(), routeOf)[0], ...over });
const prep = () => prepCase({ key: "prep:E1:d", id: "E1", title: "Platform Sync", start: new Date(NOW + 5 * 60_000).toISOString(), who: [] }, NOW, new Set(), "dsva");

test("decide: the scout can only offer; quiet and the route come first", () => {
	assert.deepEqual([decide(offer(), view()).level, decide(offer(), view()).why], ["offer", "scout: draft"]);
	assert.equal(decide(offer(), view({ quiet: (w) => w === "Kim Lee" })).level, "widget");
	assert.equal(decide({ ...offer(), route: "work" }, view({ sessionWork: false })).why, "route: session model");
	assert.equal(decide({ ...offer(), route: "personal" }, view({ sessionWork: false })).level, "offer", "personal text already reaches the session");
	assert.equal(decide({ ...away(), route: "work", nudge: "urgent" }, view({ sessionWork: false })).level, "nudge");
	assert.ok(routeOk("personal", false) && routeOk("work", true) && !routeOk("work", false));
});

test("gates: meeting, hours, busy, typing, budget and the gap", () => {
	const lvl = (c, over) => {
		const d = decide(c, view(over));
		return `${d.level} ${d.why}`;
	};
	assert.equal(lvl(away(), {}), "act rule: away");
	assert.equal(lvl(away(), { meeting: true }), "held gate: in a meeting");
	assert.equal(lvl(away(), { workHours: false }), "offer gate: after hours");
	assert.equal(lvl(away(), { idle: false }), "held gate: you are busy");
	assert.equal(lvl(away(), { pending: true }), "held gate: you are busy");
	assert.equal(lvl(away(), { editorText: true }), "held gate: you are busy", "a half-typed prompt");
	assert.equal(lvl(prep(), { lastInputAt: NOW - 30_000 }), "held gate: you typed just now");
	assert.equal(lvl(away(), { lastInputAt: NOW - 30_000 }), "act rule: away", "away ignores the typing gate (HID idle decides)");
	assert.equal(lvl(away(), { actsToday: 12 }), "offer gate: budget for today");
	assert.equal(lvl(away(), { lastActAt: NOW - 5 * 60_000 }), "held gate: 1 each 15 min");
	assert.equal(lvl(prep(), { lastActAt: NOW - 5 * 60_000 }), "act rule: prep", "prep skips the gap");
	assert.equal(lvl(prep(), { actsToday: 12 }), "offer gate: budget for today", "but not the budget");
	assert.equal(gate(away(), view()), null);
});

test("config: budget, work hours and HID idle time", () => {
	assert.deepEqual(parseBudget(undefined), { perDay: 12, gapMs: 15 * 60_000 }, "Eric's pick: 12 each day, 1 each 15 minutes");
	assert.deepEqual(parseBudget("6/30"), { perDay: 6, gapMs: 30 * 60_000 });
	assert.deepEqual(parseBudget("lots"), { perDay: 12, gapMs: 15 * 60_000 });
	assert.ok(workHoursAt(new Date(2026, 9, 6, 8, 0)));
	assert.ok(!workHoursAt(new Date(2026, 9, 6, 17, 0)));
	assert.ok(!workHoursAt(new Date(2026, 9, 4, 10, 0)), "Sunday");
	assert.equal(parseHidIdle('    |   "HIDIdleTime" = 1500000000000\n'), 1500);
	assert.equal(parseHidIdle(""), null);
});

// ── state ──

test("policy state: acts count, fired keys stick, a new day keeps only quiet, loud and ignored", () => {
	const p = newPolicy("2026-10-06");
	const c = away();
	recordAct(p, c, NOW, "2026-10-06T14:00:00-05:00");
	markFired(p, c);
	assert.equal(p.acts.length, 1);
	assert.equal(p.lastActAt, NOW);
	assert.deepEqual(p.fired, [c.key, "oddball:D1:1"]);
	markFired(p, c);
	assert.equal(p.fired.length, 2, "no duplicates");
	setLoud(p, "Lindsey Hattamer");
	setQuiet(p, "Dana Ruiz", 3, NOW);
	p.ignored["ben carter"] = 2;
	const next = rollPolicy(JSON.parse(JSON.stringify(p)), "2026-10-07", NOW + 86_400_000);
	assert.deepEqual([next.acts, next.fired, next.log, next.lastActAt], [[], [], [], 0]);
	assert.deepEqual(next.loud, ["Lindsey Hattamer"]);
	assert.deepEqual(next.ignored, { "ben carter": 2 });
	assert.ok(isQuiet(next, "dana ruiz", NOW + 86_400_000));
	const later = rollPolicy(next, "2026-10-10", NOW + 4 * 86_400_000);
	assert.deepEqual(later.quiet, {}, "quiet ends");
	assert.deepEqual(rollPolicy(undefined, "2026-10-06").acts, []);
	assert.equal(rollPolicy(p, "2026-10-06", NOW).acts.length, 1, "same day: kept");
});

test("three ignored offers in a row quiet a person for 7 days; taking one resets the count", () => {
	const p = newPolicy("2026-10-06");
	assert.equal(noteIgnored(p, "Ben Carter", NOW), undefined);
	noteTaken(p, "ben carter");
	assert.equal(noteIgnored(p, "Ben Carter", NOW), undefined);
	assert.equal(noteIgnored(p, "Ben Carter", NOW), undefined);
	const until = noteIgnored(p, "Ben  Carter", NOW);
	assert.equal(until, new Date(NOW + 7 * 86_400_000).toISOString());
	assert.ok(isQuiet(p, "Ben Carter", NOW));
	assert.ok(!isQuiet(p, "Ben Carter", NOW + 8 * 86_400_000));
	setLoud(p, "Ben Carter");
	assert.ok(!isQuiet(p, "Ben Carter", NOW), "loud undoes quiet");
});

test("/watch quiet and loud arguments", () => {
	assert.deepEqual(parsePersonArgs('"Dana Ruiz" 3d'), { who: "Dana Ruiz", days: 3 });
	assert.deepEqual(parsePersonArgs("Dana Ruiz 3d"), { who: "Dana Ruiz", days: 3 });
	assert.deepEqual(parsePersonArgs("Dana Ruiz"), { who: "Dana Ruiz", days: 7 });
	assert.equal(parsePersonArgs("  "), null);
});

test("/watch wakes lists level changes and the budget", () => {
	const p = newPolicy("2026-10-06");
	pushLog(p, { at: "2026-10-06T09:50:00-05:00", key: "k1", level: "act", why: "rule: prep", who: "Platform Sync", what: "prep · Platform Sync 10:00" });
	pushLog(p, { at: "2026-10-06T11:05:00-05:00", key: "k2", level: "held", why: "gate: in a meeting", who: "Kim Lee", what: "Kim · ATO date?" });
	recordAct(p, prep(), Date.parse("2026-10-06T09:50:00-05:00"), "2026-10-06T09:50:00-05:00");
	const text = wakesText(p, { perDay: 12, gapMs: 15 * 60_000 }, Date.parse("2026-10-06T09:55:00-05:00"));
	assert.match(text, /^watch · wakes · 2026-10-06/);
	assert.match(text, / 9:50 act {3}prep · Platform Sync 10:00 +rule: prep/);
	assert.match(text, /11:05 held  Kim · ATO date\? +gate: in a meeting/);
	assert.match(text, /acts 1 of 12 today · next act after 10:05$/);
	assert.match(wakesText(newPolicy("2026-10-06"), { perDay: 12, gapMs: 1 }), /no nudges, offers or acts yet today/);
	for (let k = 0; k < 250; k++) pushLog(p, { at: "2026-10-06T12:00:00-05:00", key: `x${k}`, level: "offer", why: "w", who: "w", what: "w" });
	assert.equal(p.log.length, 200);
});

// ── prep ──

const CALS = JSON.stringify([
	{ id: "W1", title: "Calendar", source: "Oddball (Work)", type: "exchange" },
	{ id: "H1", title: "Home", source: "iCloud", type: "caldav" },
]);
const people = (n, extra = []) => [...extra, ...Array.from({ length: n }, (_, k) => ({ name: `Person ${k}`, email: `p${k}@example.com`, status: 1 }))];
const ev = (over) => ({ id: "E1", title: "Platform Sync", start_date: "2026-10-06T19:10:00Z", end_date: "2026-10-06T19:40:00Z", all_day: false, calendar_id: "W1", attendees: people(2), status: "confirmed", ...over });

test("agenda: timed work events with 2+ attendees, not declined, canceled or skipped", () => {
	const work = workCalendarIds(CALS);
	assert.deepEqual([...work], ["W1"]);
	assert.deepEqual([...workCalendarIds("not json")], []);
	const isMe = (x) => /eric|boehs/i.test(x);
	const raw = JSON.stringify([
		ev({}),
		ev({ id: "E2", calendar_id: "H1" }),
		ev({ id: "E3", all_day: true }),
		ev({ id: "E4", attendees: people(1) }),
		ev({ id: "E5", title: "EERT Standup" }),
		ev({ id: "E6", attendees: people(2, [{ name: "Eric Boehs", email: "eric.boehs@example.com", status: 3 }]) }),
		ev({ id: "E7", status: "canceled" }),
		ev({ id: "E8", attendees: people(2, [{ name: "", email: "eric.boehs@example.com", status: 2 }]) }),
	]);
	const ms = parseAgenda(raw, work, isMe);
	assert.deepEqual(ms.map((m) => m.id), ["E1", "E8"]);
	assert.deepEqual(ms[0], { key: "prep:E1:2026-10-06T19:10:00Z", id: "E1", title: "Platform Sync", start: "2026-10-06T19:10:00Z", who: ["Person 0", "Person 1"] });
	assert.deepEqual(ms[1].who, ["Person 0", "Person 1"], "Eric is not among the people to brief on");
	const twice = parseAgenda(JSON.stringify([ev({}), ev({ start_date: "2026-10-06T21:10:00Z" }), ev({ calendar_id: "W1", attendees: [] })]), work, isMe);
	assert.deepEqual(twice.map((m) => m.key), ["prep:E1:2026-10-06T19:10:00Z", "prep:E1:2026-10-06T21:10:00Z"], "two runs in a day: two briefs");
	assert.deepEqual(parseAgenda("[{]", work, isMe), []);
	assert.deepEqual(parseAgenda(JSON.stringify([ev({ title: "Focus time" })]), work, isMe, skipPattern([])).length, 1, "an empty skip list skips nothing");
	assert.ok(skipPattern(["out of office"]).test("Out of Office"));
	assert.equal(icalTime(Date.parse("2026-10-06T19:10:00.123Z")), "2026-10-06T19:10:00Z");
});
