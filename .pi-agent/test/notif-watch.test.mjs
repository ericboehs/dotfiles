/**
 * notif-watch (bin/notif-watch, Swift): the Mac store, the iPhone store, the
 * allowlist, OTP and ICN masking, and follow mode's posted/removed/dropped events.
 *
 *   node --test .pi-agent/test/notif-watch.test.mjs
 *
 * Builds the script once with swiftc, cached by source hash in the temp dir.
 * Skipped off macOS or without swiftc, sqlite3 and plutil. The stores are made
 * up in the shapes macOS 27 writes: SQLite records with binary-plist data, and
 * NSKeyedArchiver graphs for iPhone Mirroring.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../bin/notif-watch", import.meta.url));
const has = (cmd) => spawnSync("/usr/bin/which", [cmd]).status === 0;
const skip = process.platform !== "darwin" ? "macOS only" : ["swiftc", "sqlite3", "plutil"].every(has) ? false : "needs swiftc, sqlite3 and plutil";

let BIN = "";
function build() {
	if (BIN) return BIN;
	const src = fs.readFileSync(SRC);
	const dir = path.join(os.tmpdir(), `notif-watch-test-${createHash("sha256").update(src).digest("hex").slice(0, 12)}`);
	const bin = path.join(dir, "notif-watch");
	if (!fs.existsSync(bin)) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "notif-watch.swift"), src);
		execFileSync("swiftc", ["-Onone", "-o", `${bin}.tmp`, path.join(dir, "notif-watch.swift")], { stdio: "pipe" });
		fs.renameSync(`${bin}.tmp`, bin);
	}
	BIN = bin;
	return bin;
}

// ── fixtures ──

const MAC_EPOCH = 978307200; // 2001-01-01, Apple's reference date
const macTime = (d) => d.getTime() / 1000 - MAC_EPOCH;
/** Whole seconds, so the helper's ISO times compare equal. */
const ago = (ms) => new Date(Math.floor((Date.now() - ms) / 1000) * 1000);

const isoLocal = (d) => {
	const p = (n) => String(Math.abs(n)).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
};

function plistXml(v) {
	const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const enc = (x) => {
		if (typeof x === "string") return `<string>${esc(x)}</string>`;
		if (typeof x === "boolean") return x ? "<true/>" : "<false/>";
		if (typeof x === "number") return Number.isInteger(x) ? `<integer>${x}</integer>` : `<real>${x}</real>`;
		if (Buffer.isBuffer(x)) return `<data>${x.toString("base64")}</data>`;
		if (Array.isArray(x)) return `<array>${x.map(enc).join("")}</array>`;
		return `<dict>${Object.entries(x)
			.map(([k, y]) => `<key>${esc(k)}</key>${enc(y)}`)
			.join("")}</dict>`;
	};
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${enc(v)}</plist>\n`;
}

/** An NSKeyedArchiver graph: {CF$UID} dicts become UIDs when plutil reads the XML. */
function archive(root) {
	const objects = ["$null"];
	const classes = new Map();
	const uid = (n) => ({ CF$UID: n });
	const cls = (name, chain) => {
		if (!classes.has(name)) classes.set(name, objects.push({ $classname: name, $classes: chain }) - 1);
		return uid(classes.get(name));
	};
	const add = (v) => {
		if (v === null || v === undefined) return uid(0);
		if (typeof v !== "object") return uid(objects.push(v) - 1);
		const i = objects.push("placeholder") - 1;
		if (v instanceof Date) objects[i] = { "NS.time": macTime(v), $class: cls("NSDate", ["NSDate", "NSObject"]) };
		else if (Array.isArray(v)) objects[i] = { "NS.objects": v.map(add), $class: cls("NSArray", ["NSArray", "NSObject"]) };
		else {
			const keys = Object.keys(v);
			objects[i] = {
				"NS.keys": keys.map(add),
				"NS.objects": keys.map((k) => add(v[k])),
				$class: cls("NSMutableDictionary", ["NSMutableDictionary", "NSDictionary", "NSObject"]),
			};
		}
		return uid(i);
	};
	const top = add(root);
	return { $version: 100000, $archiver: "NSKeyedArchiver", $top: { root: top }, $objects: objects };
}

/** A binary plist, swapped into place at once so a poll never sees half a file. */
function writePlist(file, value) {
	const tmp = `${file}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, plistXml(value));
	execFileSync("plutil", ["-convert", "binary1", tmp]);
	fs.renameSync(tmp, file);
}

function tmpDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notif-watch-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const APPS = { "com.apple.ical": 1, "com.apple.MobileSMS": 2, "com.tinyspeck.slackmacgap": 3 };

/** A Mac store with the real schema: app ids, and records whose data is a binary plist. */
function macStore(dir) {
	const db = path.join(dir, "db");
	const sql = (s) => execFileSync("sqlite3", [db], { input: s });
	sql(`CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
CREATE TABLE record (rec_id INTEGER PRIMARY KEY, app_id INTEGER, uuid BLOB, data BLOB, request_date REAL, request_last_date REAL, delivered_date REAL, presented Bool, style INTEGER, snooze_fire_date REAL);
${Object.entries(APPS)
	.map(([id, n]) => `INSERT INTO app VALUES (${n}, '${id}', NULL);`)
	.join("\n")}`);
	const add = ({ rec, app, title, subtitle, body, thread, at }) => {
		const file = path.join(dir, `rec${rec}.plist`);
		const req = { titl: title, body, iden: `iden-${rec}`, date: macTime(at), ...(subtitle ? { subt: subtitle } : {}), ...(thread ? { thre: thread } : {}) };
		writePlist(file, { app, date: macTime(at), uuid: Buffer.alloc(16, rec), req });
		const hex = fs.readFileSync(file).toString("hex");
		const uuid = Buffer.alloc(16, rec).toString("hex");
		sql(`INSERT INTO record (rec_id, app_id, uuid, data, delivered_date, presented, style) VALUES (${rec}, ${APPS[app]}, X'${uuid}', X'${hex}', ${macTime(at)}, 1, 1);`);
		return `mac:${uuid}`;
	};
	return { db, add, remove: (rec) => sql(`DELETE FROM record WHERE rec_id = ${rec};`) };
}

/** An iPhone Mirroring store: Library.plist maps apps to folders of DeliveredNotifications.plist. */
function iphoneStore(dir, apps) {
	const root = path.join(dir, "remote");
	fs.mkdirSync(root);
	const folders = {};
	for (const app of Object.keys(apps)) {
		folders[app] = randomUUID().toUpperCase();
		fs.mkdirSync(path.join(root, folders[app]));
	}
	writePlist(path.join(root, "Library.plist"), archive(folders));
	const file = (app) => path.join(root, folders[app], "DeliveredNotifications.plist");
	const set = (app, entries) =>
		writePlist(
			file(app),
			archive(
				entries === null
					? null
					: entries.map((e) => ({
							AppNotificationIdentifier: e.id,
							AppNotificationTitle: e.title,
							...(e.subtitle ? { AppNotificationSubtitle: e.subtitle } : {}),
							AppNotificationMessage: e.body,
							AppNotificationCreationDate: e.at,
							SBSPushStoreNotificationThreadKey: e.thread ?? "thread-1",
							ShouldPlaySound: true,
							InterruptionLevel: 1,
							...(e.sender ? { CommunicationContextSender: { displayName: e.sender, handle: "dana@example.com", handleType: 2 } } : {}),
						})),
			),
		);
	for (const [app, entries] of Object.entries(apps)) if (entries !== undefined) set(app, entries);
	return { root, file, set };
}

function run(args, input) {
	const r = spawnSync(build(), args, { input, encoding: "utf8" });
	return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
}
const events = (lines) => lines.map((l) => JSON.parse(l));

/** A --follow child, with a wait for the events seen so far to satisfy a test. */
function follow(t, args) {
	const child = spawn(build(), args, { stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => child.kill("SIGTERM"));
	const seen = [];
	const waiters = new Set();
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			seen.push(JSON.parse(buf.slice(0, i)));
			buf = buf.slice(i + 1);
		}
		for (const w of [...waiters]) w();
	});
	const until = (pred, ms = 8000) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`timed out; events so far: ${JSON.stringify(seen)}`));
			}, ms);
			function check() {
				if (!pred(seen)) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve(seen);
			}
			waiters.add(check);
			check();
		});
	return { seen, until };
}

// ── masking ──

test("mask: OTP codes in each common format and ICNs; times, dates and amounts stay", { skip }, () => {
	const cases = [
		["Your verification code is 482913", "Your verification code is [code]"],
		["482913 is your Amazon OTP. Do not share it.", "[code] is your Amazon OTP. Do not share it."],
		["G-482913 is your Google verification code.", "[code] is your Google verification code."],
		["Your Uber code: 4829. Reply STOP to unsubscribe.", "Your Uber code: [code]. Reply STOP to unsubscribe."],
		["Use 48 29 13 to sign in", "Use [code] to sign in"],
		["Enter 482-913 to verify your login", "Enter [code] to verify your login"],
		["Your code is A7X9K2", "Your code is [code]"],
		["Your code is 123456. @example.com #123456", "Your code is [code]. @example.com #[code]"],
		["Chase: Your one-time code is 12345678. Don't share it.", "Chase: Your one-time code is [code]. Don't share it."],
		["Apple Account Code: 482913. Don't share it with anyone.", "Apple Account Code: [code]. Don't share it with anyone."],
		["PIN: 0042", "PIN: [code]"],
		["Veteran 1012345678V123456 called", "Veteran [ICN] called"],
		// No code talk: digits stay.
		["Lunch at 12:30, bring $1,234.56 and call 4055551234", "Lunch at 12:30, bring $1,234.56 and call 4055551234"],
		["ATO review moved to 2:30", "ATO review moved to 2:30"],
		// Code talk, but times, dates, amounts and words stay.
		["Your sign-in at 13:52 on 10/07/2026 cost $12.50", "Your sign-in at 13:52 on 10/07/2026 cost $12.50"],
		["Your code expires in 10 minutes", "Your code expires in 10 minutes"],
	];
	const r = run(["mask"], `${cases.map(([a]) => a).join("\n")}\n`);
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.lines, cases.map(([, b]) => b));
});

// ── Mac store ──

test("--once: allowed Mac apps print masked text; others print their app id only", { skip }, (t) => {
	const dir = tmpDir(t);
	const mac = macStore(dir);
	const at = ago(5 * 60_000);
	const cal = mac.add({ rec: 1, app: "com.apple.ical", title: "EERT Weekly Sync", subtitle: "Zoom", body: "in 5 minutes · passcode 482913", at });
	mac.add({ rec: 2, app: "com.apple.MobileSMS", title: "Ashley", body: "secret family text 4829", at });
	mac.add({ rec: 3, app: "com.tinyspeck.slackmacgap", title: "Kim", body: "sent the form to Pat", thread: "C1-1791302373", at });

	// Ids match in any case: the Mac store lowercases some (com.apple.ical).
	const r = run(["--once", "--no-iphone", "--db", mac.db, "--allow", "COM.APPLE.ICAL,com.tinyspeck.slackmacgap"]);
	assert.equal(r.code, 0, r.err);
	const ev = events(r.lines);
	assert.deepEqual(ev[0], {
		ev: "posted",
		src: "mac",
		app: "com.apple.ical",
		id: cal,
		title: "EERT Weekly Sync",
		subtitle: "Zoom",
		body: "in 5 minutes · passcode [code]",
		at: isoLocal(at),
	});
	assert.deepEqual(ev[1], { ev: "dropped", src: "mac", app: "com.apple.MobileSMS", at: isoLocal(at) });
	assert.equal(ev[2].app, "com.tinyspeck.slackmacgap");
	assert.equal(ev[2].thread, "C1-1791302373");
	assert.deepEqual(ev[3], { ev: "ready", mac: "ok", iphone: "off", allowed: 2 });
	assert.equal(ev.length, 4);
	assert.doesNotMatch(r.out, /secret family|Ashley/, "a dropped app's text never leaves the helper");
});

test("--once --since prints only what is that recent", { skip }, (t) => {
	const dir = tmpDir(t);
	const mac = macStore(dir);
	mac.add({ rec: 1, app: "com.apple.ical", title: "Old", body: "two days ago", at: ago(2 * 86400_000) });
	const fresh = mac.add({ rec: 2, app: "com.apple.ical", title: "New", body: "ten minutes ago", at: ago(10 * 60_000) });
	const r = run(["--once", "--no-iphone", "--db", mac.db, "--allow", "com.apple.ical", "--since", "1d"]);
	assert.deepEqual(
		events(r.lines).filter((e) => e.ev === "posted").map((e) => e.id),
		[fresh],
	);
});

// ── iPhone store ──

test("--once: reads an allowed iPhone app's file and never opens another's", { skip }, (t) => {
	const dir = tmpDir(t);
	const at = ago(3 * 60_000);
	const phone = iphoneStore(dir, {
		"com.microsoft.Office.Outlook": [
			{ id: "OUT-1", title: "Dana Ruiz", subtitle: "ATO review", body: "Moved to 2:30. Teams code 48 29 13", at, sender: "Dana Ruiz", thread: "conv-9" },
		],
		"org.whispersystems.signal": [{ id: "SIG-1", title: "Mom", body: "family text", at }],
		"com.microsoft.skype.teams": null, // nothing on screen: the root is $null
	});
	// Unreadable: any attempt to open Signal's file would show as an error.
	fs.chmodSync(phone.file("org.whispersystems.signal"), 0o000);

	const r = run(["--once", "--no-mac", "--remote", phone.root, "--allow", "com.microsoft.office.outlook,com.microsoft.skype.teams"]);
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(events(r.lines), [
		{
			ev: "posted",
			src: "iphone",
			app: "com.microsoft.Office.Outlook",
			id: "iphone:com.microsoft.Office.Outlook:OUT-1",
			title: "Dana Ruiz",
			subtitle: "ATO review",
			body: "Moved to 2:30. Teams code [code]",
			sender: "Dana Ruiz",
			thread: "conv-9",
			at: isoLocal(at),
		},
		{ ev: "ready", mac: "off", iphone: "ok", allowed: 2 },
	]);
	assert.doesNotMatch(r.out, /family|Mom|SIG-1/);
});

test("--pretty: one readable line and the first line of the body", { skip }, (t) => {
	const dir = tmpDir(t);
	const at = ago(60_000);
	const phone = iphoneStore(dir, { "com.microsoft.Office.Outlook": [{ id: "OUT-1", title: "ATO review moved", body: "to 2:30\nsee invite", at, sender: "Dana Ruiz" }] });
	const r = run(["--once", "--pretty", "--no-mac", "--remote", phone.root, "--allow", "com.microsoft.Office.Outlook"]);
	const hh = (n) => String(n).padStart(2, "0");
	assert.deepEqual(r.lines, [
		`${hh(at.getHours())}:${hh(at.getMinutes())}:${hh(at.getSeconds())} + iPhone · Outlook · Dana Ruiz · ATO review moved`,
		"           to 2:30",
		"notif-watch · Mac off · iPhone ok · 1 app allowed",
	]);
});

// ── follow ──

test("--follow: prints what changes after the first read, plus what --since covers", { skip }, async (t) => {
	const dir = tmpDir(t);
	const mac = macStore(dir);
	const old = mac.add({ rec: 1, app: "com.apple.ical", title: "Standup", body: "yesterday", at: ago(86400_000) });
	const recent = mac.add({ rec: 2, app: "com.apple.ical", title: "1:1", body: "in 10 minutes", at: ago(5 * 60_000) });
	const phone = iphoneStore(dir, { "com.microsoft.Office.Outlook": [{ id: "OUT-1", title: "Dana Ruiz", body: "ATO review", at: ago(2 * 3600_000) }] });

	const w = follow(t, ["--follow", "--interval", "0.1", "--since", "1h", "--db", mac.db, "--remote", phone.root, "--allow", "com.apple.ical,com.microsoft.Office.Outlook"]);
	await w.until((s) => s.some((e) => e.ev === "ready"));
	assert.deepEqual(
		w.seen.map((e) => e.id ?? e.ev),
		[recent, "ready"],
		"at start: only what --since covers",
	);

	mac.remove(1);
	const added = mac.add({ rec: 3, app: "com.apple.ical", title: "Sync", body: "verification code 482913", at: ago(0) });
	mac.add({ rec: 4, app: "com.apple.MobileSMS", title: "Ashley", body: "family text", at: ago(0) });
	phone.set("com.microsoft.Office.Outlook", [{ id: "OUT-2", title: "Kim", body: "Form sent", at: ago(0) }]);

	const want = [
		["removed", old],
		["posted", added],
		["dropped", "com.apple.MobileSMS"],
		["removed", "iphone:com.microsoft.Office.Outlook:OUT-1"],
		["posted", "iphone:com.microsoft.Office.Outlook:OUT-2"],
	];
	const got = (s, [ev, key]) => s.some((e) => e.ev === ev && (e.id === key || e.app === key));
	await w.until((s) => want.every((x) => got(s, x)));
	assert.equal(w.seen.find((e) => e.id === added).body, "verification code [code]");
	assert.ok(!w.seen.some((e) => e.ev === "error"), JSON.stringify(w.seen));
	assert.ok(!JSON.stringify(w.seen).includes("family"));
});

// ── errors ──

test("a missing store is an error event; the other store still works", { skip }, (t) => {
	const dir = tmpDir(t);
	const phone = iphoneStore(dir, { "com.microsoft.Office.Outlook": [] });
	const r = run(["--once", "--db", path.join(dir, "nope"), "--remote", phone.root, "--allow", "com.microsoft.Office.Outlook"]);
	assert.equal(r.code, 0);
	assert.deepEqual(events(r.lines), [
		{ ev: "error", src: "mac", message: `no database at ${path.join(dir, "nope")}` },
		{ ev: "ready", mac: "error", iphone: "ok", allowed: 1 },
	]);
	const none = run(["--once", "--no-iphone", "--db", path.join(dir, "nope")]);
	assert.equal(none.code, 1, "every source failed");
	assert.deepEqual(events(none.lines)[0], { ev: "error", src: "allow", message: "no --allow: every app is dropped" });
});

test("apps: ids and counts from both stores, never text", { skip }, (t) => {
	const dir = tmpDir(t);
	const mac = macStore(dir);
	const at = ago(60_000);
	mac.add({ rec: 1, app: "com.apple.MobileSMS", title: "Ashley", body: "family text", at });
	mac.add({ rec: 2, app: "com.apple.MobileSMS", title: "Ashley", body: "more text", at });
	const phone = iphoneStore(dir, { "com.microsoft.Office.Outlook": [{ id: "OUT-1", title: "Dana Ruiz", body: "ATO review", at }], "com.microsoft.skype.teams": null });
	const r = run(["apps", "--db", mac.db, "--remote", phone.root, "--allow", "com.microsoft.Office.Outlook"]);
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.lines, ["✓ iphone     1  com.microsoft.Office.Outlook  (Outlook)", "  mac        2  com.apple.MobileSMS  (Messages)"]);
});
