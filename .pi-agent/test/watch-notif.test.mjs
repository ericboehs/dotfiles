/**
 * watch/apps.ts and watch/notif.ts: which apps the watcher asks for, where each
 * one goes, notif-watch's lines, and the supervisor that runs it.
 *
 * The supervisor runs against a fake notif-watch (a node script) so these run
 * anywhere; notif-watch.test.mjs covers the real binary.
 *
 * Run: node --test .pi-agent/test/watch-notif.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { APP_GROUPS, allowList, appFor, appsText, DEFAULT_APPS, pickGroups } from "../extensions/watch/apps.ts";
import { notifProblem, notifSummary, parseNotifLine, superviseNotifWatch } from "../extensions/watch/notif.ts";

// ── apps ──

test("PI_WATCH_APPS picks groups in table order; off, none and empty pick none", () => {
	assert.deepEqual(
		pickGroups(DEFAULT_APPS).groups.map((g) => g.key),
		["slack", "mail", "work", "calls", "msgs"],
	);
	assert.deepEqual(
		pickGroups("msgs, Slack").groups.map((g) => g.key),
		["slack", "msgs"],
	);
	for (const off of ["", "off", "none", " , "]) assert.deepEqual(pickGroups(off), { groups: [], unknown: [] });
	assert.deepEqual(pickGroups("slack,teams,teams").unknown, ["teams"]);
});

test("the allow list: each id once, sorted, and nothing outside the groups", () => {
	const ids = allowList(APP_GROUPS);
	assert.deepEqual(ids, [...new Set(ids)].sort());
	assert.ok(ids.includes("com.apple.mobilephone"));
	assert.ok(!ids.some((id) => /gmail|discord|whatsapp/i.test(id)), "only the apps Eric picked");
	assert.deepEqual(allowList(pickGroups("slack").groups), ["com.tinyspeck.chatlyio", "com.tinyspeck.slackmacgap"]);
});

test("routes: work text only to the work scout, Messages and Signal only to the personal scout", () => {
	const byKey = Object.fromEntries(APP_GROUPS.map((g) => [g.key, g]));
	assert.ok(byKey.work.apps.every((a) => a.route === "work"), "Outlook and Teams go to VA Copilot");
	assert.ok(byKey.msgs.apps.every((a) => a.route === "personal"));
	assert.ok(byKey.slack.apps.every((a) => a.route === "wake"), "Slack text is read through slk, not the banner");
	const personal = APP_GROUPS.flatMap((g) => g.apps).filter((a) => a.route === "personal");
	assert.ok(!personal.some((a) => /microsoft|tinyspeck|ical|mobilecal|fantastical/i.test(a.id)), "no work-adjacent app on the personal route");
	const seen = new Map();
	for (const g of APP_GROUPS)
		for (const a of g.apps) {
			const k = `${a.id.toLowerCase()}|${a.device}`;
			assert.ok(!seen.has(k), `${k} is in both ${seen.get(k)} and ${g.key}`);
			seen.set(k, g.key);
		}
});

test("appFor matches any case and prefers the device's own entry", () => {
	assert.equal(appFor("com.apple.mobilesms", "mac")?.group, "msgs", "the Mac store lowercases ids");
	assert.equal(appFor("COM.MICROSOFT.SKYPE.TEAMS", "iphone")?.route, "work");
	assert.deepEqual(
		[appFor("com.apple.mobilephone", "mac")?.device, appFor("com.apple.mobilephone", "iphone")?.device],
		["mac", "iphone"],
	);
	assert.equal(appFor("com.example.game", "mac"), undefined);
	assert.equal(appFor("com.apple.mobilesms", "mac", pickGroups("slack").groups), undefined, "only groups that are on");
});

test("/watch apps: a row per group and route with counts, groups off marked, never text", () => {
	const text = appsText({
		groups: pickGroups("slack,work,calls").groups,
		state: "Mac ok · iPhone ok",
		seen: { "slack:wake": 3, "calls:rules": 1 },
		onScreen: { "slack:wake": 1 },
		dropped: 12,
	});
	const lines = text.split("\n");
	assert.equal(lines[0], "watch · apps · notifications: Mac ok · iPhone ok");
	assert.match(text, /^✓ {3}wake {12}Slack \(Mac, iPhone\) → an early Slack read +3 +1$/m);
	assert.match(text, /^✓ {3}rules {11}Phone, FaceTime \(Mac, iPhone\) +1 +0$/m);
	assert.match(text, /^✓ {3}work scout {6}Calendar, Fantastical \(Mac, iPhone\) +0 +0$/m);
	assert.match(text, /^✕ {3}— +Mail, Fastmail \(Mac, iPhone\)$/m, "off: no counts");
	assert.match(text, /^✕ {3}— +Messages, Signal/m);
	assert.match(text, /dropped in notif-watch, 12 this session/);
});

// ── notif-watch lines ──

test("parseNotifLine keeps known events, fills missing text with empty strings, clips long fields", () => {
	assert.deepEqual(parseNotifLine('{"ev":"posted","src":"iphone","app":"com.apple.MobileSMS","id":"iphone:x:1","title":"Ashley","body":"[code] is yours"}'), {
		ev: "posted",
		src: "iphone",
		app: "com.apple.MobileSMS",
		id: "iphone:x:1",
		title: "Ashley",
		subtitle: "",
		body: "[code] is yours",
		sender: "",
		thread: "",
		at: "",
	});
	assert.equal(parseNotifLine(JSON.stringify({ ev: "posted", src: "mac", app: "a", id: "i", body: "x".repeat(5000) })).body.length, 2000);
	assert.deepEqual(parseNotifLine('{"ev":"removed","src":"mac","app":"a","id":"mac:1"}'), { ev: "removed", src: "mac", app: "a", id: "mac:1" });
	assert.deepEqual(parseNotifLine('{"ev":"ready","mac":"ok","iphone":"off","allowed":"3"}'), { ev: "ready", mac: "ok", iphone: "off", allowed: 3 });
	assert.deepEqual(parseNotifLine('{"ev":"error","message":"no database"}'), { ev: "error", src: "notif-watch", message: "no database" });
	assert.deepEqual(parseNotifLine('{"ev":"ok","src":"mac"}'), { ev: "ok", src: "mac" });
});

test("parseNotifLine rejects what is not a whole, known event", () => {
	for (const line of [
		"",
		"not json",
		"[1,2]",
		"null",
		'{"ev":"posted","src":"mac","app":"a"}', // no id
		'{"ev":"posted","src":"android","app":"a","id":"i"}',
		'{"ev":"posted","src":"mac","app":7,"id":"i"}',
		'{"ev":"dropped","src":"mac"}',
		'{"ev":"surprise","src":"mac"}',
	])
		assert.equal(parseNotifLine(line), null, line);
});

test("notifProblem is quiet when fine; notifSummary names each store", () => {
	const st = (over) => ({ state: "running", mac: "ok", iphone: "ok", error: "", restarts: 0, ...over });
	assert.equal(notifProblem(st()), "");
	assert.equal(notifProblem(undefined), "");
	assert.equal(notifProblem(st({ state: "stopped" })), "");
	assert.equal(notifProblem(st({ state: "missing" })), "notif-watch missing");
	assert.equal(notifProblem(st({ state: "restarting" })), "notif-watch restarting");
	assert.equal(notifProblem(st({ mac: "error", iphone: "error" })), "Mac and iPhone notifications unread");
	assert.equal(notifSummary(st({ iphone: "off" })), "Mac ok · iPhone off");
	assert.equal(notifSummary(st({ iphone: "error", error: "iphone: no Library.plist" })), "Mac ok · iPhone error · iphone: no Library.plist");
	assert.equal(notifSummary(st({ state: "missing", error: "notif-watch not on PATH" })), "notif-watch missing (notif-watch not on PATH)");
});

// ── supervisor ──

function tmpDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-notif-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A notif-watch stand-in: logs its args and pid, prints `lines`, then exits on the first run and stays up after. */
function fakeBin(dir, lines) {
	const bin = path.join(dir, "notif-watch");
	fs.writeFileSync(
		bin,
		`#!${process.execPath}
const fs = require("fs");
const log = ${JSON.stringify(path.join(dir, "runs"))};
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }) + "\\n");
const run = fs.readFileSync(log, "utf8").trim().split("\\n").length;
for (const l of ${JSON.stringify(lines)}) process.stdout.write(l.replaceAll("RUN", String(run)) + "\\n");
if (run === 1) { process.stderr.write("notif-watch: boom\\n"); setTimeout(() => process.exit(3), 30); }
else setInterval(() => {}, 1000);
`,
		{ mode: 0o755 },
	);
	return bin;
}

const runs = (dir) =>
	fs
		.readFileSync(path.join(dir, "runs"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

async function until(fn, ms = 5000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("supervisor: passes the allow list, reports events and status, restarts after a crash, stop kills it", async (t) => {
	const dir = tmpDir(t);
	const bin = fakeBin(dir, [
		JSON.stringify({ ev: "error", src: "iphone", message: "no library" }),
		JSON.stringify({ ev: "ready", mac: "ok", iphone: "error", allowed: 2 }),
		JSON.stringify({ ev: "posted", src: "mac", app: "com.tinyspeck.slackmacgap", id: "mac:RUN", title: "t" }),
		"not json",
		JSON.stringify({ ev: "ok", src: "iphone" }),
	]);
	const events = [];
	const statuses = [];
	const h = superviseNotifWatch({ bin, allow: ["b.app", "a.app"], onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s), restartMs: 40 });
	t.after(() => h.stop());
	await until(() => events.filter((e) => e.ev === "posted").length === 2);
	await until(() => h.status().iphone === "ok" && h.status().restarts === 1);

	assert.deepEqual(runs(dir)[0].args, ["--follow", "--allow", "b.app,a.app"]);
	assert.deepEqual(
		events.filter((e) => e.ev === "posted").map((e) => e.id),
		["mac:1", "mac:2"],
	);
	assert.ok(!events.some((e) => e === null), "the junk line is skipped");
	const crash = statuses.find((s) => s.state === "restarting");
	assert.equal(crash.error, "boom", "the last stderr line, prefix dropped");
	assert.deepEqual(statuses.at(-1), { state: "running", mac: "ok", iphone: "ok", error: "", restarts: 1 }, "ok clears the iPhone error");

	const pid = runs(dir)[1].pid;
	assert.ok(alive(pid));
	h.stop();
	assert.equal(h.status().state, "stopped");
	await until(() => !alive(pid));
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(runs(dir).length, 2, "no restart after stop");
});

test("supervisor: a missing binary is reported once and not retried", async (t) => {
	const dir = tmpDir(t);
	const statuses = [];
	const h = superviseNotifWatch({ bin: path.join(dir, "nope"), allow: ["a"], onEvent: () => {}, onStatus: (s) => statuses.push(s), restartMs: 20 });
	t.after(() => h.stop());
	await until(() => h.status().state === "missing");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(statuses.filter((s) => s.state === "starting").length, 1);
	assert.equal(h.status().state, "missing");
	assert.match(h.status().error, /not on PATH/);
	assert.equal(notifProblem(h.status()), "notif-watch missing");
});
