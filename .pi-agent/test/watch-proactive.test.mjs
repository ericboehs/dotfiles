/**
 * watch.ts, end to end: a real /watch start against fake slk, eert-bot-feed,
 * ical and ioreg, and a fake scout. One loop finds an urgent DM and a meeting
 * 5 minutes out; the prep brief acts (a guarded turn), the urgent draft waits
 * on it, and /watch do runs it once pi settles.
 *
 *   node --test .pi-agent/test/watch-proactive.test.mjs
 *
 * All people, meetings and messages here are made up.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const NOW = new Date(2026, 9, 6, 10, 0).getTime(); // a Tuesday, 10:00 local

function fakeBins(dir) {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const write = (name, body) => {
		fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconst now = Number(process.env.FAKE_NOW);\n${body}\n`, { mode: 0o755 });
	};
	write(
		"slk",
		`const ws = a[a.indexOf("-w") + 1];
if (a[0] === "unread") console.log(JSON.stringify(ws === "oddball" ? { channels: [], dms: [{ id: "D1", mentions: 1, name: "Kim Lee" }] } : { channels: [], dms: [] }));
else if (a[0] === "activity") console.log("[]");
else if (a[0] === "sent") console.log(JSON.stringify({ results: [] }));
else if (a[0] === "messages" && a[1] === "D1") console.log(JSON.stringify([{ ts: String((now - 5 * 60000) / 1000), user_id: "U1", user_name: "Kim Lee", text: "urgent: when is the ATO date?" }]));
else if (a[0] === "search") console.log("1 hit");
else console.log("[]");`,
	);
	write("eert-bot-feed", `console.log("[]");`);
	write(
		"ical",
		`if (a[0] === "calendars") console.log(JSON.stringify([{ id: "W1", title: "Calendar", source: "Oddball (Work)" }, { id: "H1", title: "Home", source: "iCloud" }]));
else console.log(JSON.stringify([
  { id: "E1", title: "Platform Sync", start_date: new Date(now + 5 * 60000).toISOString(), all_day: false, calendar_id: "W1", attendees: [{ name: "Alex Teal", status: 1 }, { name: "Kim Lee", status: 2 }], status: "confirmed" },
  { id: "E2", title: "Dentist", start_date: new Date(now + 6 * 60000).toISOString(), all_day: false, calendar_id: "H1", attendees: [{ name: "A" }, { name: "B" }] },
]));`,
	);
	write("ioreg", `console.log('  "HIDIdleTime" = 5000000000');`); // 5 s: Eric is at the Mac
	return bin;
}

test("one loop: prep acts with a guarded turn, the urgent draft waits, /watch do runs it after the settle", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-proactive-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const env = {
		PATH: `${fakeBins(dir)}:${process.env.PATH}`,
		FAKE_NOW: String(NOW),
		PI_WATCH_SLACK_DIR: path.join(dir, "data"),
		PI_WATCH_SLACK_DAILY_DIR: "",
		PI_WATCH_SLACK_ABOUT: path.join(dir, "none.md"),
		PI_WATCH_SLACK_ME: "Eric Boehs",
		PI_WATCH_SLACK_WORKSPACES: "oddball,dsva",
		PI_WATCH_APPS: "off",
		PI_WATCH_ACTS: "12/15",
		XDG_CACHE_HOME: path.join(dir, "cache"),
	};
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	});
	t.mock.timers.enable({ apis: ["Date"], now: NOW });
	const { default: watch } = await import(`../extensions/watch.ts?proactive=${Date.now()}`);

	const handlers = {};
	const commands = {};
	const tools = [];
	const sent = [];
	const notes = [];
	const pi = {
		on: (ev, fn) => (handlers[ev] = fn),
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		registerTool: (tool) => tools.push(tool),
		sendMessage: (m, opts) => sent.push({ ...m, opts }),
	};
	watch(pi);
	const scoutCalls = [];
	const registry = {
		find: (provider, id) => ({ provider, id, name: id }),
		hasConfiguredAuth: () => true,
		streamSimple: (model, req) => {
			scoutCalls.push({ model: `${model.provider}/${model.id}`, user: req.messages[0].content });
			const reply = req.systemPrompt.includes("You triage Slack")
				? '{"items":[{"id":"m1","bucket":"needs","why":"ATO date?","offer":"draft","offerWhy":"draft from the ATO notes"}],"waits":[]}'
				: '{"waits":[]}';
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
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: (m, level) => notes.push(`${level}: ${m}`), setWidget: (_k, w) => (widget = w), getEditorText: () => "" },
	};
	handlers.session_start({}, ctx);
	t.mock.timers.tick(3 * 60_000); // Eric last typed at load: 3 minutes ago now
	await commands.watch.handler("start", ctx);
	t.after(() => commands.watch.handler("stop", ctx));

	// Only Date is mocked: setTimeout is real, so wait for the first loop to finish.
	for (let k = 0; k < 400 && !sent.some((m) => m.details?.kind === "act"); k++) await new Promise((r) => setTimeout(r, 25));

	// The scout sorted Kim's DM; work text never went to the personal scout and vice versa.
	assert.ok(scoutCalls.some((c) => c.model.startsWith("opencode-go/") && /ATO date/.test(c.user)));
	assert.ok(!scoutCalls.some((c) => c.model.startsWith("github-copilot/") && /ATO date/.test(c.user)), "oddball text stays on the personal scout");

	// A nudge toast for the urgent DM.
	assert.ok(notes.some((n) => /^warning: watch · urgent · Kim \(oddball DM\) ATO date\?/.test(n)), notes.join("\n"));

	// Prep acted: one guarded turn, with the meeting in an untrusted block; the iCloud dentist never shows.
	const acts = sent.filter((m) => m.details?.kind === "act");
	assert.equal(acts.length, 1);
	assert.deepEqual(acts[0].opts, { triggerTurn: true });
	assert.match(acts[0].content, /^watch · prep · Platform Sync 10:05 · act 1 of 12 today/);
	assert.match(acts[0].content, /<untrusted meeting="10:05">\nPlatform Sync\nAttendees: Alex Teal, Kim Lee\n<\/untrusted>/);
	assert.match(acts[0].content, /watch_lookup searches the notes, or Slack in dsva/);
	assert.ok(!sent.some((m) => /Dentist/.test(m.content)));

	// The guard: read tools only until pi settles after the turn.
	assert.equal(handlers.tool_call({ toolName: "bash" }).block, true);
	assert.equal(handlers.tool_call({ toolName: "web_search" }), undefined);
	assert.equal(handlers.tool_call({ toolName: "web_fetch" }).block, true);

	// The urgent draft waits on the running turn, numbered in the widget.
	const lines = widget(undefined, { fg: (_c, s) => s }).render(200);
	assert.match(lines[0], /1 needs you · 1 held/);
	assert.ok(lines.some((l) => /⏸ urgent · Kim · ATO date\? held · you are busy · \/watch do 1/.test(l)), lines.join("\n"));
	await commands.watch.handler("do 1", ctx);
	assert.match(notes.at(-1), /pi is busy/);

	handlers.agent_start({});
	handlers.agent_settled({});
	assert.equal(handlers.tool_call({ toolName: "bash" }), undefined, "settled: every tool again");

	await commands.watch.handler("do 1", ctx);
	const second = sent.filter((m) => m.details?.kind === "act");
	assert.equal(second.length, 2);
	assert.match(second[1].content, /^watch · urgent · Kim · ATO date\? · you asked/);
	assert.match(second[1].content, /<untrusted from="Kim Lee" where="oddball DM" at="09:55">\nurgent: when is the ATO date\?\n<\/untrusted>/);
	assert.match(second[1].content, /watch_lookup searches the notes, or Slack in oddball/);
	assert.equal(handlers.tool_call({ toolName: "edit" }).block, true, "armed again");

	// watch_lookup in this turn searches only oddball Slack.
	const hit = await tools[0].execute("id", { source: "slack", query: "ATO date" });
	assert.equal(hit.content[0].text, "1 hit");

	// The log, the budget (a /watch do doesn't count), and the files.
	await commands.watch.handler("wakes", ctx);
	const wakes = sent.at(-1).content;
	assert.match(wakes, /act {3}prep · Platform Sync 10:05 +rule: prep/);
	assert.match(wakes, /held {2}urgent · Kim · ATO date\? +gate: you are busy/);
	assert.match(wakes, /nudge Kim · ATO date\? +urgent/);
	assert.match(wakes, /act {3}urgent · Kim · ATO date\? +you: \/watch do/);
	assert.match(wakes, /acts 1 of 12 today · next act after 10:18/);
	await commands.watch.handler("", ctx);
	assert.match(notes.at(-1), /acts 1 of 12 today/);
	const policy = JSON.parse(fs.readFileSync(path.join(dir, "data", "policy.json"), "utf8"));
	assert.equal(policy.acts.length, 1);
	assert.ok(policy.fired.includes("prep:E1:" + new Date(NOW + 5 * 60_000).toISOString().slice(0, 10)));
	assert.ok(policy.fired.includes("urgent:oddball:D1:"));
	assert.equal(fs.statSync(path.join(dir, "data", "policy.json")).mode & 0o777, 0o600);

	await commands.watch.handler('quiet "Kim Lee" 2d', ctx);
	assert.match(notes.at(-1), /No offers or acts for Kim Lee until/);
	await commands.watch.handler('loud "Kim Lee"', ctx);
	assert.match(notes.at(-1), /Kim Lee: DMs nudge, and urgent can act/);
});
