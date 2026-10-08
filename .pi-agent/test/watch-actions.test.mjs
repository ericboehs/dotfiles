/**
 * watch/actions.ts and the mute rules in watch/policy.ts: bursts, links,
 * snooze times, /watch mute parsing, the picker panel; sender counts and the
 * snooze carry-over in watch.ts.
 *
 *   node --test .pi-agent/test/watch-actions.test.mjs
 *
 * All people and messages here are made up.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	bursts,
	convoKey,
	defaultVerb,
	iconOf,
	isSnoozed,
	linkOf,
	osc8,
	PickerPanel,
	parseMuteArgs,
	slackLink,
	snoozeEnd,
} from "../extensions/watch/actions.ts";
import { addMute, muteFor, muteLabel, newPolicy, removeMute, rollPolicy, rulesText } from "../extensions/watch/policy.ts";
import { buildTriageUser, carryOver, needsList, senderLines, senderStats } from "../extensions/watch.ts";

const T = 1791302400; // 2026-10-06 ~09:00 CDT
function item(over = {}) {
	const ws = over.workspace ?? "oddball";
	const channel = over.channel ?? "D1";
	const ts = over.ts ?? String(T);
	return {
		key: `${ws}:${channel}:${ts}`,
		at: "2026-10-06T09:00:00-05:00",
		workspace: ws,
		channel,
		where: "oddball DM",
		from: "Kim Lee",
		agent: false,
		text: "lunch?",
		bucket: "needs",
		why: "lunch?",
		state: "open",
		sentToAgent: false,
		ts,
		kind: "dm",
		readKeys: [`ch:${ws}:${channel}`],
		wasUnread: true,
		...over,
	};
}
const text = (over = {}) =>
	item({ key: `notif:iphone:sms:${over.id ?? 1}`, workspace: "iPhone", channel: "Messages", where: "iPhone · Messages", kind: "text", route: "personal", ...over });

// ── bursts ──

test("bursts: one person, one conversation, each within 10 minutes of another", () => {
	const a = item({ ts: String(T) });
	const b = item({ ts: String(T + 300) });
	const c = item({ ts: String(T + 900) }); // 10 min after b: still the burst
	const d = item({ ts: String(T + 2400) }); // 25 min after c: a new row
	const other = item({ from: "Pat Doe", ts: String(T + 60) });
	const rows = bursts([d, c, b, other, a]);
	assert.deepEqual(
		rows.map((r) => r.items.map((i) => i.ts)),
		[[String(T + 2400)], [String(T + 900), String(T + 300), String(T)], [String(T + 60)]],
	);
	assert.equal(rows[1].lead, c, "the lead is the first given: needsList puts the newest first");
});

test("bursts: a wait reply and a maybe keep their own rows; threads and channels split", () => {
	const wait = item({ ts: String(T + 10), closesWait: "W1" });
	const plain = item({ ts: String(T + 20) });
	const maybe = item({ ts: String(T + 30), maybeWait: "W2" });
	assert.equal(bursts([maybe, plain, wait]).length, 3);
	const t1 = item({ ts: String(T), channel: "C1", threadTs: "1" });
	const t2 = item({ ts: String(T + 5), channel: "C1", threadTs: "2" });
	assert.equal(bursts([t2, t1]).length, 2);
});

test("bursts: a text's conversation is its app and sender, across devices' ids", () => {
	const a = text({ id: 1, ts: String(T) });
	const b = text({ id: 2, ts: String(T + 120) });
	const c = text({ id: 3, ts: String(T + 60), from: "Pat Doe" });
	assert.deepEqual(
		bursts([b, c, a]).map((r) => r.items.length),
		[2, 1],
	);
	assert.equal(convoKey(a), "n|Messages|kim lee");
});

test("isSnoozed and needsList leave a snoozed item out until its time", () => {
	const now = Date.parse("2026-10-06T10:00:00-05:00");
	const s = item({ snoozeUntil: "2026-10-06T11:00:00-05:00" });
	assert.equal(isSnoozed(s, now), true);
	assert.equal(isSnoozed(s, now + 2 * 3_600_000), false);
	assert.deepEqual(needsList([s], now), []);
	assert.deepEqual(needsList([s], now + 2 * 3_600_000), [s]);
});

// ── links ──

test("linkOf: Slack messages and threads; tickets only with a ServiceNow URL", () => {
	assert.deepEqual(linkOf(item({ ts: "1791302400.000100" })), { url: "https://oddball.slack.com/archives/D1/p1791302400000100", label: "Slack message" });
	assert.equal(
		linkOf(item({ channel: "C9", ts: "1791302400.000200", threadTs: "1791302000.000100" })).url,
		"https://oddball.slack.com/archives/C9/p1791302400000200?thread_ts=1791302000.000100&cid=C9",
	);
	assert.equal(slackLink("dsva", "C1", "17.5", "17.5"), "https://dsva.slack.com/archives/C1/p175", "a thread's parent has no thread_ts");
	const t = text({ text: "any word on RITM1234567?" });
	assert.equal(linkOf(t), undefined, "no base URL: no ticket link");
	assert.deepEqual(linkOf(t, "https://example.service-now.com/"), {
		url: "https://example.service-now.com/nav_to.do?uri=task.do%3Fsysparm_query%3Dnumber%3DRITM1234567",
		label: "RITM1234567",
	});
	assert.equal(linkOf(text({ text: "see you at 3" }), "https://x"), undefined);
	assert.equal(linkOf(item({ channel: FEED_LIKE })), undefined, "a channel id that isn't Slack's shape has no link");
});
const FEED_LIKE = "feed";

test("defaultVerb: an offer asks, a link opens, else done", () => {
	assert.equal(defaultVerb(item({ offer: "draft" }), true), "ask");
	assert.equal(defaultVerb(item(), true), "open");
	assert.equal(defaultVerb(text(), false), "done");
});

test("osc8 wraps a label in a terminal link", () => {
	assert.equal(osc8("https://x.test", "x"), "\x1b]8;;https://x.test\x1b\\x\x1b]8;;\x1b\\");
	assert.equal(visibleWidth(osc8("https://x.test", "label")), 5);
});

// ── snooze ──

test("snoozeEnd: hours, tomorrow 8 AM, Monday 8 AM (next week's on a Monday)", () => {
	const tue = new Date(2026, 9, 6, 22, 30);
	assert.equal(snoozeEnd("1 hour", tue).getTime(), tue.getTime() + 3_600_000);
	assert.equal(snoozeEnd("3 hours", tue).getTime(), tue.getTime() + 3 * 3_600_000);
	assert.equal(snoozeEnd("2h", tue).getTime(), tue.getTime() + 2 * 3_600_000);
	assert.deepEqual(snoozeEnd("tomorrow 8 AM", tue), new Date(2026, 9, 7, 8, 0));
	assert.deepEqual(snoozeEnd("Monday 8 AM", tue), new Date(2026, 9, 12, 8, 0));
	assert.deepEqual(snoozeEnd("Monday 8 AM", new Date(2026, 9, 12, 7, 0)), new Date(2026, 9, 19, 8, 0));
	assert.deepEqual(snoozeEnd("monday", new Date(2026, 9, 11, 7, 0)), new Date(2026, 9, 12, 8, 0), "Sunday: tomorrow");
	assert.equal(snoozeEnd("someday", tue), undefined);
});

// ── mutes ──

test("parseMuteArgs: from, text, in, for; needs from or text", () => {
	const now = Date.parse("2026-10-06T10:00:00Z");
	assert.deepEqual(parseMuteArgs('from "YourRequestedCertificate@va.gov" in Outlook', now), { from: "YourRequestedCertificate@va.gov", app: "Outlook" });
	assert.deepEqual(parseMuteArgs('text "weekly digest" for 7d', now), { text: "weekly digest", until: "2026-10-13T10:00:00.000Z" });
	assert.deepEqual(parseMuteArgs("from Robo in dsva for 12h", now), { from: "Robo", app: "dsva", until: "2026-10-06T22:00:00.000Z" });
	assert.equal(parseMuteArgs("in Outlook", now), null);
	assert.equal(parseMuteArgs("", now), null);
});

test("muteFor: every field set must match; an ended rule matches nothing", () => {
	const now = Date.parse("2026-10-06T10:00:00Z");
	const outlook = text({ channel: "Outlook", where: "iPhone · Outlook", from: "YourRequestedCertificate@va.gov", text: "Your certificate is ready", kind: "work" });
	const rules = [
		{ id: "M1", from: "yourrequestedcertificate@VA.gov", app: "outlook", hits: 0 },
		{ id: "M2", text: "WEEKLY DIGEST", hits: 0 },
		{ id: "M3", from: "Kim Lee", until: "2026-10-06T09:00:00Z", hits: 0 },
		{ id: "M4", app: "dsva", hits: 0 },
	];
	assert.equal(muteFor(outlook, rules, now)?.id, "M1", "any case, app by channel or where");
	assert.equal(muteFor({ ...outlook, channel: "Teams", where: "iPhone · Teams" }, rules, now), undefined, "another app");
	assert.equal(muteFor(item({ text: "the Weekly Digest is out" }), rules, now)?.id, "M2");
	assert.equal(muteFor(item(), rules, now), undefined, "M3 ended; M4 has no from or text, so it matches nothing");
	assert.equal(muteFor(item(), rules, Date.parse("2026-10-06T08:00:00Z"))?.id, "M3");
});

test("addMute, removeMute, rulesText; rollPolicy keeps mutes across days and drops ended ones", () => {
	const now = Date.parse("2026-10-06T10:00:00Z");
	const p = newPolicy("2026-10-06");
	const a = addMute(p, { from: "Robo Bot" });
	const b = addMute(p, { text: "digest", app: "Outlook", until: "2026-10-07T10:00:00Z" });
	assert.deepEqual([a.id, b.id, a.hits], ["M1", "M2", 0]);
	assert.equal(addMute(p, { from: "Robo Bot", until: "2026-10-09T00:00:00Z" }), a, "the same rule again only moves its end");
	assert.equal(a.until, "2026-10-09T00:00:00Z");
	addMute(p, { from: "Robo Bot" });
	assert.equal(a.until, undefined, "and back to always");
	assert.equal(muteLabel(b), 'text "digest" in Outlook');
	const rules = rulesText(p, now);
	assert.match(rules, /^watch · rules\nM1 {3}mute from "Robo Bot" · 0 dropped\nM2 {3}mute text "digest" in Outlook until 2026-10-07 10:00 · 0 dropped/);
	const next = rollPolicy(JSON.parse(JSON.stringify(p)), "2026-10-08", Date.parse("2026-10-08T10:00:00Z"));
	assert.deepEqual(next.mutes.map((m) => m.id), ["M1"], "a new day keeps mutes; M2 ended");
	assert.equal(next.nextMute, 3, "ids are never reused");
	assert.deepEqual(rollPolicy({ day: "2026-10-06" }, "2026-10-06").mutes, [], "a policy.json from before mutes");
	assert.equal(removeMute(p, "m2")?.id, "M2");
	assert.equal(removeMute(p, "M9"), undefined);
	assert.match(rulesText(newPolicy("2026-10-06"), now), /no mutes/);
});

// ── sender counts and carry-over (watch.ts) ──

test("senderStats counts Slack DMs and mentions to Eric, answered or not; senderLines only for 3 or more", () => {
	const stats = senderStats([
		item({ ts: "1", clearedBy: "answered" }),
		item({ ts: "2", clearedBy: "read" }),
		item({ ts: "3" }),
		item({ ts: "4", from: "Pat Doe", kind: "mention" }),
		item({ ts: "5", from: "Bot", agent: true }),
		item({ ts: "6", from: "Robo", mutedBy: "M1" }),
		text({ ts: "7", from: "Kim Lee" }),
	]);
	assert.deepEqual(stats, { "kim lee": { n: 3, answered: 1 }, "pat doe": { n: 1, answered: 0 } });
	const batch = [{ item: item({ ts: "9" }) }, { item: item({ ts: "10" }) }, { item: item({ ts: "11", from: "Pat Doe" }) }];
	assert.deepEqual(senderLines(batch, stats), ["Kim Lee: answered 1 of 3"]);
	const user = buildTriageUser(batch.map((b, k) => ({ id: `m${k + 1}`, item: b.item })), [], [], new Date(2026, 9, 6, 10, 0), stats);
	assert.match(user, /Open waits:\n\(none\)\nSenders, last 7 days \(messages answered of messages seen\):\nKim Lee: answered 1 of 3\n\n<items>/);
	assert.ok(!/Senders/.test(buildTriageUser(batch.map((b, k) => ({ id: `m${k + 1}`, item: b.item })), [], [], new Date())), "no stats: no line");
});

test("carryOver: open needs with a snooze move to the new day; the rest stay behind", () => {
	const keep = item({ ts: "1", snoozeUntil: "2026-10-12T08:00:00-05:00" });
	const past = [keep, item({ ts: "2" }), item({ ts: "3", snoozeUntil: "x", state: "cleared" }), item({ ts: "4", snoozeUntil: "x", bucket: "context" })];
	assert.deepEqual(carryOver(past, new Map()), [keep]);
	assert.deepEqual(carryOver(past, new Map([[keep.key, keep]])), [], "already in today's ledger");
});

// ── the picker ──

const theme = { fg: (_c, s) => s };
function panel(rows, over = {}) {
	const out = { result: "open", renders: 0 };
	const p = new PickerPanel({
		tui: { requestRender: () => out.renders++ },
		theme,
		title: "watch · 2 need you",
		rows,
		selected: 0,
		flash: "",
		canUndo: false,
		done: (r) => (out.result = r),
		...over,
	});
	return { p, out };
}
const rows = [
	{ icon: "✉", label: "Kim Lee (oddball DM) lunch?", age: "3m", count: 2, verb: "open" },
	{ icon: "◇", label: "Dana Ruiz (iPhone · Messages) the ticket", age: "1h", count: 1, verb: "done" },
];

test("picker: rows, a ×N for bursts, the selected row's Enter verb, keys that fit", () => {
	const { p } = panel(rows);
	const lines = p.render(80);
	assert.deepEqual(lines.slice(0, 4), ["watch · 2 need you", "", "❯ 1 ✉ Kim Lee (oddball DM) lunch? ×2 3m", "  2 ◇ Dana Ruiz (iPhone · Messages) the ticket 1h"]);
	assert.match(lines.at(-1), /^enter open · o open · a ask agent/);
	assert.ok(!lines.at(-1).includes("u undo"));
	for (const l of p.render(30)) assert.ok(visibleWidth(l) <= 30, l);
	assert.deepEqual(panel([]).p.render(80).slice(0, 3), ["watch · 2 need you", "", "  Nothing needs you."]);
});

test("picker: j/k and arrows wrap, digits jump, Enter is the default, letters are verbs, q and esc close", () => {
	let { p, out } = panel(rows);
	p.handleInput("j");
	assert.match(p.render(80)[3], /^❯ 2/);
	p.handleInput("j");
	assert.match(p.render(80)[2], /^❯ 1/, "wraps");
	p.handleInput("\x1b[A"); // up
	assert.match(p.render(80)[3], /^❯ 2/);
	p.handleInput("1");
	p.handleInput("\r");
	assert.deepEqual(out.result, { verb: "open", row: 0 });
	for (const [k, verb] of Object.entries({ o: "open", a: "ask", d: "done", s: "snooze", m: "mute", w: "wait" })) {
		({ p, out } = panel(rows, { selected: 1 }));
		p.handleInput(k);
		assert.deepEqual(out.result, { verb, row: 1 }, k);
	}
	({ p, out } = panel(rows));
	p.handleInput("u");
	assert.equal(out.result, "open", "no undo to do: u does nothing");
	({ p, out } = panel(rows, { canUndo: true, flash: "Cleared · Kim" }));
	assert.ok(p.render(80).includes("  Cleared · Kim"));
	p.handleInput("u");
	assert.deepEqual(out.result, { verb: "undo", row: 0 });
	({ p, out } = panel(rows));
	p.handleInput("\x1b");
	assert.equal(out.result, undefined);
	({ p, out } = panel([]));
	p.handleInput("d");
	assert.equal(out.result, "open", "no rows: verbs do nothing");
	p.handleInput("q");
	assert.equal(out.result, undefined);
	assert.equal(panel(rows, { selected: 9 }).p.render(80)[3].startsWith("❯ 2"), true, "a stale selection clamps");
});

test("iconOf: the widget's marks", () => {
	assert.deepEqual(
		[item({ closesWait: "W1" }), item({ maybeWait: "W1" }), item({ kind: "feed-ask" }), item({ kind: "mention" }), item(), text({ kind: "call" }), text(), item({ kind: "thread" })].map((i) => iconOf(i).ch).join(""),
		"✓?!@✉◇◇↳",
	);
});
