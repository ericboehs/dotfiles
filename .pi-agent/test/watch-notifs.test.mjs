/**
 * watch/notifs.ts: which notifications become items, their fields, one item
 * per message across devices, and clearing.
 *
 *   node --test .pi-agent/test/watch-notifs.test.mjs
 *
 * All people and messages here are made up.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { appFor } from "../extensions/watch/apps.ts";
import {
	clearNotifs,
	goneAfterReplay,
	notifFields,
	notifIdsOf,
	notifKind,
	sameNotif,
	srcOfId,
} from "../extensions/watch/notifs.ts";
import { awayCases, nudgeOf, offerCase, slackWsOf, urgentCase } from "../extensions/watch/policy.ts";

const NOW = Date.parse("2026-10-07T13:52:30-05:00");
const posted = (over = {}) => ({
	ev: "posted",
	src: "iphone",
	app: "com.apple.MobileSMS",
	id: "iphone:com.apple.MobileSMS:1",
	title: "Kim Lee",
	subtitle: "",
	body: "Can you grab feed on the way home?",
	sender: "",
	thread: "",
	at: "2026-10-07T13:52:04-05:00",
	...over,
});
const app = (id, src = "iphone") => appFor(id, src);

test("kinds: texts, work, missed calls and calendar alerts; Slack, mail and live calls make none", () => {
	assert.equal(notifKind(app("com.apple.MobileSMS"), false), "text");
	assert.equal(notifKind(app("org.whispersystems.signal"), false), "text");
	assert.equal(notifKind(app("com.microsoft.skype.teams"), false), "work");
	assert.equal(notifKind(app("com.microsoft.Outlook", "mac"), false), "work");
	assert.equal(notifKind(app("com.apple.mobilephone"), true), "call");
	assert.equal(notifKind(app("com.apple.mobilephone"), false), null, "ringing, or a call that ended");
	assert.equal(notifKind(app("com.apple.ical", "mac"), false), "event");
	assert.equal(notifKind(app("com.flexibits.fantastical2.iphone"), false), "event");
	assert.equal(notifKind(app("com.tinyspeck.chatlyio"), false), null, "Slack text comes from slk");
	assert.equal(notifKind(app("com.fastmail.FastMail"), false), null, "mail waits for its reader");
});

test("a text: the sender, the message, the device; routed to the personal scout", () => {
	const f = notifFields(posted(), app("com.apple.MobileSMS"), "text", NOW);
	assert.deepEqual(f, {
		key: "notif:iphone:com.apple.MobileSMS:1",
		workspace: "iphone",
		channel: "Messages",
		where: "iPhone · Messages",
		from: "Kim Lee",
		text: "Can you grab feed on the way home?",
		ts: (Date.parse("2026-10-07T13:52:04-05:00") / 1000).toFixed(6),
		kind: "text",
		route: "personal",
		forced: false,
		readKeys: ["notif:iphone:com.apple.MobileSMS:1"],
	});
	const group = notifFields(posted({ title: "Farm crew", sender: "Ben Carter", body: "Hay Saturday?" }), app("com.apple.MobileSMS"), "text", NOW);
	assert.equal(group.from, "Ben Carter");
	assert.equal(group.text, "Farm crew — Hay Saturday?", "the group name stays with the text");
});

test("Outlook keeps the subject; Teams and calendar route to the work scout", () => {
	const mail = notifFields(
		posted({ app: "com.microsoft.Office.Outlook", id: "iphone:o:1", title: "Dana Ruiz", subtitle: "ATO review moved", body: "Now at 2:30   in the usual room" }),
		app("com.microsoft.Office.Outlook"),
		"work",
		NOW,
	);
	assert.deepEqual([mail.from, mail.text, mail.where, mail.route], ["Dana Ruiz", "ATO review moved — Now at 2:30 in the usual room", "iPhone · Outlook", "work"]);
	const cal = notifFields(posted({ src: "mac", app: "com.apple.ical", id: "mac:c1", title: "EERT Weekly Sync", body: "in 5 minutes" }), app("com.apple.ical", "mac"), "event", NOW);
	assert.deepEqual([cal.from, cal.text, cal.where, cal.route], ["Calendar", "EERT Weekly Sync — in 5 minutes", "Mac · Calendar", "work"]);
});

test("a missed call: the caller, needs Eric by rule, no model", () => {
	const phone = notifFields(posted({ app: "com.apple.mobilephone", id: "iphone:p:1", title: "Missed Call", body: "Alex Teal" }), app("com.apple.mobilephone"), "call", NOW);
	assert.deepEqual([phone.from, phone.text, phone.route, phone.forced], ["Alex Teal", "Missed Call", null, true]);
	const ft = notifFields(posted({ app: "com.apple.facetime", id: "iphone:f:1", title: "Alex Teal", body: "Missed FaceTime Audio" }), app("com.apple.facetime"), "call", NOW);
	assert.deepEqual([ft.from, ft.text], ["Alex Teal", "Missed FaceTime Audio"]);
	const anon = notifFields(posted({ app: "com.apple.mobilephone", id: "iphone:p:2", title: "Missed Call", body: "" }), app("com.apple.mobilephone"), "call", NOW);
	assert.equal(anon.from, "unknown caller");
});

test("time: the notification's, unless it's missing or from the future", () => {
	const nowTs = (NOW / 1000).toFixed(6);
	assert.equal(notifFields(posted({ at: "" }), app("com.apple.MobileSMS"), "text", NOW).ts, nowTs);
	assert.equal(notifFields(posted({ at: "2026-10-08T13:52:04-05:00" }), app("com.apple.MobileSMS"), "text", NOW).ts, nowTs);
	assert.equal(notifFields(posted({ body: "x".repeat(900) }), app("com.apple.MobileSMS"), "text", NOW, 500).text.length, 500);
});

test("one message on the Mac and the iPhone is one item", () => {
	const phone = notifFields(posted(), app("com.apple.MobileSMS"), "text", NOW);
	const mac = notifFields(posted({ src: "mac", id: "mac:abc", at: "2026-10-07T13:52:09-05:00", body: "Can you grab feed on the way home?!" }), app("com.apple.MobileSMS", "mac"), "text", NOW);
	assert.ok(sameNotif(phone, mac), "punctuation and devices aside");
	assert.ok(!sameNotif(phone, phone), "not with itself");
	assert.ok(!sameNotif(phone, { ...mac, from: "Ben Carter" }));
	assert.ok(!sameNotif(phone, { ...mac, text: "Never mind, got it" }));
	assert.ok(!sameNotif(phone, { ...mac, ts: String(Number(phone.ts) + 600) }), "ten minutes apart: two messages");
	assert.ok(!sameNotif(phone, { ...mac, channel: "Signal" }));
	assert.ok(!sameNotif({ ...phone, key: "oddball:D1:1" }, mac), "never a Slack item");
	const long = "a".repeat(80);
	assert.ok(sameNotif({ ...phone, text: `${long} and the rest` }, { ...mac, text: `${long}…` }), "one device cut it shorter");
});

test("clearing: an item goes when any of its notifications does; after a restart, what wasn't replayed", () => {
	const items = [
		{ key: "notif:iphone:a", state: "open", bucket: "needs", readKeys: ["notif:iphone:a", "notif:mac:b"] },
		{ key: "notif:mac:c", state: "open", bucket: "context", readKeys: ["notif:mac:c"] },
		{ key: "notif:mac:d", state: "open", bucket: "drop", readKeys: ["notif:mac:d"] },
		{ key: "oddball:D1:1", state: "open", bucket: "needs", readKeys: ["ch:oddball:D1"] },
	];
	const now = "2026-10-07T14:00:00-05:00";
	const byMac = clearNotifs(items, (id) => id === "mac:b", now);
	assert.deepEqual(byMac.map((i) => [i.key, i.state, i.clearedBy, i.clearedAt]), [["notif:iphone:a", "cleared", "read", now]], "read on the Mac: gone from both");
	assert.deepEqual(clearNotifs(items, () => true, now).map((i) => i.key), ["notif:iphone:a", "notif:mac:c"], "never a dropped or Slack item");
	const gone = goneAfterReplay(new Set(["iphone:a"]), new Set(["iphone"]));
	assert.equal(gone("iphone:a"), false, "replayed: still on screen");
	assert.equal(gone("iphone:z"), true);
	assert.equal(gone("mac:c"), false, "the Mac store failed to read: judge nothing there");
	assert.deepEqual(notifIdsOf(items[0].readKeys), ["iphone:a", "mac:b"]);
	assert.deepEqual([srcOfId("mac:x"), srcOfId("iphone:x"), srcOfId("x")], ["mac", "iphone", ""]);
});

// ── policy on notification items ──

const textItem = (over = {}) => ({
	key: "notif:iphone:t1",
	ts: ((NOW - 60_000) / 1000).toFixed(6),
	workspace: "iphone",
	channel: "Messages",
	where: "iPhone · Messages",
	from: "Kim Lee",
	kind: "text",
	text: "urgent: the gate is open and the cows are out",
	why: "cows out",
	bucket: "needs",
	state: "open",
	...over,
});

test("policy: an urgent text nudges and acts like a DM, with no Slack to search", () => {
	assert.equal(nudgeOf(textItem(), [], () => false), "urgent");
	assert.equal(slackWsOf(textItem()), null);
	assert.equal(slackWsOf({ key: "dsva:D1:1", workspace: "dsva" }), "dsva");
	const c = urgentCase({ ...textItem(), nudge: "urgent" }, [], "personal", new Set(), NOW);
	assert.equal(c.key, "urgent:Messages:kim lee", "one per sender, not one for all of Messages");
	assert.equal(c.workspace, null);
	const o = offerCase({ ...textItem(), offer: "draft" }, "personal", new Set(), NOW);
	assert.equal(o.workspace, null);
	const away = awayCases(
		[{ ...textItem(), offer: "draft" }, { ...textItem({ key: "oddball:D1:1", workspace: "oddball", channel: "D1", kind: "dm" }), offer: "draft" }],
		1800,
		new Set(),
		(i) => (i.key.startsWith("notif:") ? "personal" : "personal"),
	);
	assert.deepEqual(away.map((x) => [x.workspace, x.items.length]), [[null, 1], ["oddball", 1]], "texts get their own turn, without Slack");
});
