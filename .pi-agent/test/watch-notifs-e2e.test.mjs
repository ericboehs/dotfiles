/**
 * watch.ts with notifications, end to end: a real /watch start with a fake
 * notif-watch, fake slk and a fake scout per route. Texts reach only the
 * personal scout, Teams and calendar only the work scout, a missed call no
 * model. One text on two devices is one item; removing it on either clears it;
 * a restart clears what's no longer on screen and adds nothing twice.
 *
 *   node --test .pi-agent/test/watch-notifs-e2e.test.mjs
 *
 * All people and messages here are made up.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20_000) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return;
	assert.fail("timed out");
}

function fakeBins(dir) {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nconst a = process.argv.slice(2);\n${body}\n`, { mode: 0o755 });
	write(
		"slk",
		`if (a[0] === "unread") console.log(JSON.stringify({ channels: [], dms: [] }));
else if (a[0] === "sent") console.log(JSON.stringify({ results: [] }));
else console.log("[]");`,
	);
	write("eert-bot-feed", `console.log("[]");`);
	// Run 1: a ready, then live notifications, then the Mac copy of the text goes away.
	// Run 2 (after a restart): only the Teams message is still on screen.
	write(
		"notif-watch",
		`const fs = require("node:fs");
const runFile = ${JSON.stringify(path.join(dir, "runs"))};
const run = (Number(fs.existsSync(runFile) ? fs.readFileSync(runFile, "utf8") : 0) || 0) + 1;
fs.writeFileSync(runFile, String(run));
fs.writeFileSync(${JSON.stringify(path.join(dir, "args"))}, JSON.stringify(a));
const at = new Date().toISOString();
const out = (o) => console.log(JSON.stringify(o));
const teams = { ev: "posted", src: "iphone", app: "com.microsoft.skype.teams", id: "iphone:teams:1", title: "Dana Ruiz", subtitle: "", body: "Can you review the ATO memo today?", sender: "", thread: "", at };
if (run === 1) {
  out({ ev: "ready", mac: "ok", iphone: "ok", allowed: 20 });
  setTimeout(() => {
    out({ ev: "posted", src: "iphone", app: "com.apple.MobileSMS", id: "iphone:sms:1", title: "Kim Lee", subtitle: "", body: "urgent: the cows are out on the road", sender: "", thread: "", at });
    out({ ev: "posted", src: "mac", app: "com.apple.MobileSMS", id: "mac:sms-1", title: "Kim Lee", subtitle: "", body: "urgent: the cows are out on the road", sender: "", thread: "", at });
    out(teams);
    out({ ev: "posted", src: "iphone", app: "com.apple.mobilephone", id: "iphone:call:1", title: "Missed Call", subtitle: "", body: "Alex Teal", sender: "", thread: "", at });
    out({ ev: "posted", src: "mac", app: "com.apple.ical", id: "mac:cal-1", title: "EERT Weekly Sync", subtitle: "", body: "in 5 minutes", sender: "", thread: "", at });
    out({ ev: "posted", src: "iphone", app: "com.fastmail.FastMail", id: "iphone:fm:1", title: "Ben Carter", subtitle: "Hay", body: "Saturday?", sender: "", thread: "", at });
  }, 300);
  process.on("SIGUSR2", () => out({ ev: "removed", src: "mac", app: "com.apple.MobileSMS", id: "mac:sms-1" }));
} else {
  out(teams);
  out({ ev: "ready", mac: "ok", iphone: "ok", allowed: 20 });
}
fs.writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(process.pid));
setInterval(() => {}, 1e9);`,
	);
	return bin;
}

test("notifications become items: routed by app, one per message, cleared when gone, reconciled on restart", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-notifs-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const env = {
		PATH: `${fakeBins(dir)}:${process.env.PATH}`,
		PI_WATCH_DIR: path.join(dir, "data"),
		PI_WATCH_DAILY_DIR: "",
		PI_WATCH_ABOUT: path.join(dir, "none.md"),
		PI_WATCH_ME: "Eric Boehs",
		PI_WATCH_WORKSPACES: "oddball,dsva",
		PI_WATCH_WORK_WORKSPACES: "dsva",
		PI_WATCH_APPS: "slack,mail,work,calls,msgs",
		PI_WATCH_NOTIF_BIN: "notif-watch",
		PI_WATCH_PREP: "off",
		XDG_CACHE_HOME: path.join(dir, "cache"),
	};
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	});
	const mod = await import(`../extensions/watch.ts?notifs=${Date.now()}`);
	const { default: watch, ledgerLatest } = mod;

	const handlers = {};
	const commands = {};
	const notes = [];
	const pi = {
		on: (ev, fn) => (handlers[ev] = fn),
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		sendMessage: () => {},
	};
	watch(pi);
	const calls = []; // [model, item kinds in the batch, the user prompt]
	const registry = {
		find: (provider, id) => ({ provider, id, name: id }),
		hasConfiguredAuth: () => true,
		streamSimple: (model, req) => {
			const user = req.messages[0].content;
			const rows = [...user.matchAll(/^(m\d+) · ([^·\n]+) ·/gm)].map((m) => ({ id: m[1], kind: m[2].trim() }));
			calls.push([`${model.provider}/${model.id}`, rows.map((r) => r.kind), user]);
			const items = rows.map((r) => ({ id: r.id, bucket: r.kind === "calendar alert" ? "context" : "needs", why: r.kind === "text message" ? "cows out on the road" : r.kind === "calendar alert" ? "weekly sync soon" : "review the ATO memo" }));
			const reply = req.systemPrompt.includes("You triage Slack") ? JSON.stringify({ items, waits: [] }) : '{"waits":[]}';
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: reply }], usage: { cost: { total: 0 } } }) };
		},
	};
	let widget;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: { provider: "github-copilot", id: "claude-opus-5.5" },
		modelRegistry: registry,
		isIdle: () => false, // Eric is mid-turn: no act starts here
		hasPendingMessages: () => false,
		ui: { notify: (m, level) => notes.push(`${level}: ${m}`), setWidget: (_k, w) => (widget = w), getEditorText: () => "" },
	};
	handlers.session_start({}, ctx);
	await commands.watch.handler("start", ctx);
	t.after(() => commands.watch.handler("stop", ctx));

	const day = new Date();
	const ledgerFile = path.join(dir, "data", `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}.jsonl`);
	const items = () => (fs.existsSync(ledgerFile) ? ledgerLatest(fs.readFileSync(ledgerFile, "utf8")) : new Map());
	const notifItems = () => [...items().values()].filter((i) => i.key.startsWith("notif:"));

	await until(() => fs.existsSync(path.join(dir, "args")));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "args"), "utf8")).slice(-2), ["--since", "24h"], "each start replays what's on screen");

	// The missed call is an item at once, by rule, with a toast.
	await until(() => notifItems().some((i) => i.kind === "call"));
	const call = notifItems().find((i) => i.kind === "call");
	assert.deepEqual([call.from, call.bucket, call.why, call.where, call.route], ["Alex Teal", "needs", "missed call", "iPhone · Phone", undefined]);

	// The rest after the scout runs (a loop 10 s after the first notification).
	await until(() => notifItems().filter((i) => i.why).length >= 4, 25_000);
	const byKind = Object.fromEntries(notifItems().map((i) => [i.kind, i]));
	assert.equal(notifItems().length, 4, "text (both devices), Teams, call, calendar; no Fastmail item");
	assert.deepEqual(byKind.text.readKeys, ["notif:iphone:sms:1", "notif:mac:sms-1"], "one item for both copies");
	assert.deepEqual([byKind.text.bucket, byKind.text.why, byKind.text.route, byKind.text.nudge], ["needs", "cows out on the road", "personal", "urgent"]);
	assert.deepEqual([byKind.work.bucket, byKind.work.from, byKind.work.route], ["needs", "Dana Ruiz", "work"]);
	assert.deepEqual([byKind.event.bucket, byKind.event.text, byKind.event.route], ["context", "EERT Weekly Sync — in 5 minutes", "work"]);

	// Routing: texts only to the personal scout; Teams and calendar only to VA Copilot; the call to neither.
	const kindsFor = (prefix) => calls.filter(([m]) => m.startsWith(prefix)).flatMap(([, kinds]) => kinds);
	assert.deepEqual(kindsFor("opencode-go/").sort(), ["text message"]);
	assert.deepEqual(kindsFor("github-copilot/").sort(), ["Outlook/Teams notification", "calendar alert"]);
	assert.ok(!calls.some(([, , user]) => /Alex Teal|missed call/.test(user)), "a missed call never reaches a model");
	assert.ok(!calls.some(([m, , user]) => m.startsWith("opencode-go/") && /ATO memo/.test(user)), "work text never reaches the personal scout");
	assert.ok(!calls.some(([, , user]) => /Hay|Saturday/.test(user)), "mail banners make no item yet");
	assert.ok(notes.some((n) => /^warning: watch · urgent/.test(n) && /Kim/.test(n)), notes.join("\n"));

	// Widget: notification items show with ◇.
	const lines = widget(undefined, { fg: (_c, s) => s }).render(200);
	assert.ok(lines.some((l) => /◇ Kim \(iPhone · Messages\) cows out on the road/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /◇ Alex \(iPhone · Phone\) missed call/.test(l)), lines.join("\n"));

	// Read on the Mac: the Mac copy goes away and the one item clears.
	process.kill(Number(fs.readFileSync(path.join(dir, "pid"), "utf8")), "SIGUSR2");
	await until(() => notifItems().find((i) => i.kind === "text")?.state === "cleared");
	assert.equal(notifItems().find((i) => i.kind === "text").clearedBy, "read");
	assert.equal(notifItems().find((i) => i.kind === "work").state, "open");

	// Restart: only Teams is still on screen. The call and the calendar alert clear; nothing doubles.
	await commands.watch.handler("stop", ctx);
	await commands.watch.handler("start", ctx);
	await until(() => notifItems().find((i) => i.kind === "event")?.state === "cleared");
	const after = notifItems();
	assert.equal(after.length, 4, "the replayed Teams message is the same item");
	assert.deepEqual(
		Object.fromEntries(after.map((i) => [i.kind, i.state])),
		{ text: "cleared", work: "open", call: "cleared", event: "cleared" },
	);
});
