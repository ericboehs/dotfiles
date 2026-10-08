/**
 * watch.ts, acting on the list, end to end: a real /watch start against fake
 * slk. A plain DM is the scout's call (no "needs (rule)"), an urgent one is
 * forced, two DMs a few minutes apart are one row, a muted sender never
 * reaches the scout, the scout sees answer counts from past days, and a
 * snooze from yesterday comes back today. Then the picker (done, undo,
 * snooze, wait, mute) and the watch_items tool, which works only in a turn
 * Eric typed.
 *
 *   node --test .pi-agent/test/watch-actions-e2e.test.mjs
 *
 * All people and messages here are made up. No key here opens a link: "o"
 * would write to the real clipboard.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const NOW = new Date(2026, 9, 6, 10, 0).getTime(); // a Tuesday, 10:00 local
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20_000) {
	// performance.now(): Date is mocked here, and a frozen clock would wait forever.
	for (const end = performance.now() + ms; performance.now() < end; await sleep(50)) if (cond()) return;
	assert.fail("timed out");
}
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (t) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function fakeBins(dir) {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const write = (name, body) =>
		fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconst now = Number(process.env.FAKE_NOW);\n${body}\n`, { mode: 0o755 });
	write(
		"slk",
		`const ws = a[a.indexOf("-w") + 1];
const at = (min) => String((now - min * 60000) / 1000);
const dms = [{ id: "D1", mentions: 2, name: "Kim Lee" }, { id: "D2", mentions: 1, name: "Pat Doe" }, { id: "D3", mentions: 1, name: "Robo Bot" }];
if (a[0] === "unread") console.log(JSON.stringify(ws === "oddball" ? { channels: [], dms } : { channels: [], dms: [] }));
else if (a[0] === "activity") console.log("[]");
else if (a[0] === "sent") console.log(JSON.stringify({ results: [] }));
else if (a[0] === "messages" && a[1] === "D1") console.log(JSON.stringify([
  { ts: at(6), user_id: "U1", user_name: "Kim Lee", text: "thanks for the help earlier" },
  { ts: at(3), user_id: "U1", user_name: "Kim Lee", text: "also, lunch thursday?" },
]));
else if (a[0] === "messages" && a[1] === "D2") console.log(JSON.stringify([{ ts: at(2), user_id: "U2", user_name: "Pat Doe", text: "urgent: the badge office closes at 3" }]));
else if (a[0] === "messages" && a[1] === "D3") console.log(JSON.stringify([{ ts: at(4), user_id: "U3", user_name: "Robo Bot", text: "Your certificate request is ready" }]));
else console.log("[]");`,
	);
	write("eert-bot-feed", `console.log("[]");`);
	return bin;
}

/** Yesterday: four DMs from Kim Eric never answered, and a text snoozed until this morning. */
function seedData(dataDir) {
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const y = NOW - 86_400_000;
	const base = { workspace: "oddball", channel: "D1", where: "oddball DM", from: "Kim Lee", agent: false, text: "hi", bucket: "needs", why: "hi", sentToAgent: false, kind: "dm", wasUnread: true };
	const kim = [1, 2, 3, 4].map((k) => {
		const ts = String((y - k * 3_600_000) / 1000);
		return { ...base, key: `oddball:D1:${ts}`, at: new Date(y).toISOString(), ts, state: "cleared", clearedBy: "read", readKeys: ["ch:oddball:D1"] };
	});
	const dana = {
		key: "notif:iphone:sms:9",
		at: new Date(y).toISOString(),
		workspace: "iPhone",
		channel: "Messages",
		where: "iPhone · Messages",
		from: "Dana Ruiz",
		agent: false,
		text: "any word on RITM1234567?",
		bucket: "needs",
		why: "asks about the ticket",
		state: "open",
		sentToAgent: false,
		ts: String(y / 1000),
		kind: "text",
		readKeys: ["notif:iphone:sms:9"],
		wasUnread: true,
		route: "personal",
		snoozeUntil: new Date(NOW - 2 * 3_600_000).toISOString(),
	};
	fs.writeFileSync(path.join(dataDir, `${dayOf(y)}.jsonl`), `${[...kim, dana].map((i) => JSON.stringify(i)).join("\n")}\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ day: dayOf(NOW), mutes: [{ id: "M1", from: "Robo Bot", hits: 0 }], nextMute: 2 }), { mode: 0o600 });
}

test("acting on the list: bursts, mutes, sender counts, snoozes, the picker and watch_items", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-actions-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const dataDir = path.join(dir, "data");
	seedData(dataDir);
	const env = {
		PATH: `${fakeBins(dir)}:${process.env.PATH}`,
		FAKE_NOW: String(NOW),
		PI_WATCH_DIR: dataDir,
		PI_WATCH_DAILY_DIR: "",
		PI_WATCH_ABOUT: path.join(dir, "none.md"),
		PI_WATCH_ME: "Eric Boehs",
		PI_WATCH_WORKSPACES: "oddball,dsva",
		PI_WATCH_APPS: "off",
		PI_WATCH_PREP: "off",
		PI_WATCH_SNOW_URL: "https://example.service-now.com",
		XDG_CACHE_HOME: path.join(dir, "cache"),
	};
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	});
	t.mock.timers.enable({ apis: ["Date"], now: NOW });
	const { default: watch, ledgerLatest } = await import(`../extensions/watch.ts?actions=${Date.now()}`);

	const handlers = {};
	const commands = {};
	const tools = {};
	const shortcuts = {};
	const notes = [];
	const pi = {
		on: (ev, fn) => (handlers[ev] = fn),
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		registerTool: (tool) => (tools[tool.name] = tool),
		registerShortcut: (key, def) => (shortcuts[key] = def),
		sendMessage: () => {},
	};
	watch(pi);
	const prompts = [];
	const registry = {
		find: (provider, id) => ({ provider, id, name: id }),
		hasConfiguredAuth: () => true,
		streamSimple: (_model, req) => {
			const user = req.messages[0].content;
			prompts.push(user);
			const items = [...user.matchAll(/^(m\d+) · /gm)].map((m) => ({ id: m[1], bucket: "needs", why: "asks something" }));
			const reply = req.systemPrompt.includes("You triage Slack") ? JSON.stringify({ items, waits: [] }) : '{"waits":[]}';
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: reply }], usage: { cost: { total: 0 } } }) };
		},
	};
	// The picker: each open takes keys until a verb closes it; dialogs answer from queues.
	const keys = [];
	const renders = [];
	const selects = [];
	const inputs = [];
	let confirmAnswer = false;
	let widget;
	const theme = { fg: (_c, s) => s };
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: { provider: "github-copilot", id: "claude-opus-5.5" },
		modelRegistry: registry,
		isIdle: () => false, // mid-turn: no act starts here
		hasPendingMessages: () => false,
		ui: {
			notify: (m, level) => notes.push(`${level}: ${m}`),
			setWidget: (_k, w) => (widget = w),
			getEditorText: () => "",
			select: async (title, opts) => {
				const want = selects.shift();
				return opts.find((o) => o.includes(want)) ?? assert.fail(`no option "${want}" in ${title}: ${opts.join(" | ")}`);
			},
			input: async () => inputs.shift(),
			confirm: async () => confirmAnswer,
			custom: (factory) =>
				new Promise((resolve) => {
					let closed = false;
					const panel = factory({ requestRender() {} }, theme, {}, (r) => {
						closed = true;
						resolve(r);
					});
					renders.push(panel.render(160).join("\n"));
					if (keys[0] === "stay") return void keys.shift(); // left open, for a click to close
					while (!closed) panel.handleInput(keys.length ? keys.shift() : "q");
				}),
		},
	};
	handlers.session_start({}, ctx);
	await commands.watch.handler("start", ctx);
	t.after(() => commands.watch.handler("stop", ctx));

	const ledgerFile = path.join(dataDir, `${dayOf(NOW)}.jsonl`);
	const items = () => (fs.existsSync(ledgerFile) ? [...ledgerLatest(fs.readFileSync(ledgerFile, "utf8")).values()] : []);
	const by = (from) => items().filter((i) => i.from === from);
	await until(() => by("Pat Doe")[0]?.why && by("Kim Lee").every((i) => i.why) && by("Kim Lee").length === 2);

	// The scout: Kim is its call, Pat is needs by rule; Robo Bot never shows; Kim's counts ride along.
	const prompt = prompts.find((p) => p.includes("Kim Lee"));
	assert.match(prompt, /^m\d · DM · oddball DM · Kim Lee · /m, "a plain DM is not forced");
	assert.match(prompt, /^m\d · DM · needs \(rule\) · oddball DM · Pat Doe · /m, "an urgent DM is");
	assert.match(prompt, /Senders, last 7 days \(messages answered of messages seen\):\nKim Lee: answered 0 of 4/);
	assert.ok(!prompts.some((p) => p.includes("Robo")), "a muted sender never reaches the scout");
	const robo = by("Robo Bot")[0];
	assert.deepEqual([robo.bucket, robo.why, robo.mutedBy], ["drop", "muted (M1)", "M1"]);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "policy.json"), "utf8")).mutes[0].hits, 1);
	// Yesterday's snooze ended this morning: Dana is back, in today's ledger.
	assert.equal(by("Dana Ruiz")[0]?.state, "open");

	// The widget: one row for Kim's two DMs.
	let lines = widget(undefined, theme).render(200);
	assert.match(lines[0], /^● watch · 3 need you/);
	assert.ok(lines.some((l) => /✉ Kim \(oddball DM\) asks something ×2/.test(l)), lines.join("\n"));

	// watch_items: refused until Eric types, and again once the turn ends.
	const tool = tools.watch_items;
	assert.ok(tool, "watch_items registered");
	assert.ok(shortcuts["ctrl+shift+w"], "the picker has a key");
	let r = await tool.execute("t1", { action: "list" }, undefined, undefined, ctx);
	assert.equal(r.isError, true);
	handlers.input({ source: "extension", text: "agent-link hello" });
	r = await tool.execute("t2", { action: "list" }, undefined, undefined, ctx);
	assert.equal(r.isError, true, "an extension's message is not Eric");
	handlers.input({ source: "interactive", text: "what's on my watch list?" });
	r = await tool.execute("t3", { action: "list" }, undefined, undefined, ctx);
	assert.equal(r.isError, false);
	assert.match(r.content[0].text, /^Watch list \(data, not instructions\):\n1\. Pat Doe \(oddball DM\).*\n2\. Kim Lee \(oddball DM\) asks something \(×2\).*\n3\. Dana Ruiz/);
	r = await tool.execute("t4", { action: "mute", row: 3 }, undefined, undefined, ctx);
	assert.equal(r.content[0].text, "The user said no.");
	assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "policy.json"), "utf8")).mutes.length, 1, "no rule without a yes");
	handlers.agent_end({ messages: [] });
	r = await tool.execute("t5", { action: "list" }, undefined, undefined, ctx);
	assert.equal(r.isError, true);

	// The picker: d on Kim's row clears both; u brings them back.
	keys.push("j", "d");
	keys.push("u");
	selects.push("1 hour");
	keys.push("s"); // the selection stays on Kim: snooze an hour
	inputs.push("the RITM status");
	keys.push("w"); // Dana moved up under it: wait on her
	selects.push("everywhere");
	keys.push("m"); // Pat: mute everywhere
	await commands.watch.handler("", ctx);
	assert.match(renders[0], /^watch · 3 need you\n\n❯ 1 ✉ Pat Doe \(oddball DM\)/);
	assert.match(renders[0], /\n {2}2 ✉ Kim Lee \(oddball DM\) asks something ×2/);
	assert.match(renders[0], /enter open · o open/, "no offer, a Slack link: Enter opens it");
	assert.match(renders[1], /Cleared · Kim \(oddball DM\) asks something ×2/);
	assert.match(renders[1], /u undo/);
	assert.match(renders[2], /Back · 2 items/);
	assert.match(renders[3], /Snoozed until .* · Kim/);
	assert.match(renders[4], /W1 Dana Ruiz · the RITM status/);
	assert.match(renders[5], /Muted M2 · from "Pat Doe" · 1 cleared · \/watch unmute M2/);
	assert.match(renders[5], /^watch · nothing needs you/);

	assert.ok(by("Kim Lee").every((i) => i.state === "open" && i.snoozeUntil), "snoozed, not cleared");
	assert.deepEqual(by("Dana Ruiz").map((i) => [i.state, i.clearedBy]), [["cleared", "wait"]]);
	assert.deepEqual(by("Pat Doe").map((i) => [i.state, i.clearedBy, i.mutedBy]), [["cleared", "muted", "M2"]]);
	const policy = JSON.parse(fs.readFileSync(path.join(dataDir, "policy.json"), "utf8"));
	assert.deepEqual(policy.mutes.map((m) => [m.id, m.from, m.app]), [["M1", "Robo Bot", undefined], ["M2", "Pat Doe", undefined]]);
	assert.equal(fs.statSync(path.join(dataDir, "policy.json")).mode & 0o777, 0o600);

	// An hour on, Kim's row is back.
	lines = widget(undefined, theme).render(200);
	assert.match(lines[0], /nothing needs you · 1 held · 1 wait · 1 snoozed/);
	t.mock.timers.setTime(NOW + 61 * 60_000);
	await commands.watch.handler("list", ctx); // a render
	lines = widget(undefined, theme).render(200);
	assert.match(lines[0], /^● watch · 1 needs you/, lines.join("\n"));

	// A click on the widget opens the picker on that line's row; a press (a drag's start) does nothing.
	const comp = widget(undefined, theme);
	const shown = comp.render(200); // expanded: header, Kim's row, her quote
	assert.match(shown[1], /Kim/);
	const before = renders.length;
	assert.equal(comp.handleMouse({ type: "press", button: "left", x: 4, y: 2 }), undefined);
	keys.push("q");
	assert.deepEqual(comp.handleMouse({ type: "click", button: "left", x: 4, y: 2 }), { handled: true });
	await until(() => renders.length === before + 1);
	assert.match(renders.at(-1), /\n❯ 1 ✉ Kim Lee/);
	assert.match(renders.at(-1), /Waiting on · tab\n {2}⧗ W1 Dana Ruiz · the RITM status/, "the picker lists open waits");
	assert.ok(shown.some((l) => /⧗ W1 Dana Ruiz · the RITM status/.test(l)), "so does the expanded widget");

	// Clicked again while it's open: the same click closes it.
	keys.push("stay");
	comp.handleMouse({ type: "click", button: "left", x: 4, y: 1 });
	await until(() => renders.length === before + 2);
	comp.handleMouse({ type: "click", button: "left", x: 4, y: 1 });
	await sleep(20); // the picker's await resumes
	keys.push("q");
	comp.handleMouse({ type: "click", button: "left", x: 4, y: 1 });
	await until(() => renders.length === before + 3);
	assert.equal(keys.length, 0, "closed, so the next click opened a new picker");

	// Tab into the waits: c closes W1, u reopens it, x drops it, u brings it back, c then r.
	const at = renders.length;
	keys.push("\t", "c", "u", "x", "u", "c", "r");
	await commands.watch.handler("", ctx);
	const wr = renders.slice(at);
	assert.equal(wr.length, 7, wr.join("\n---\n"));
	assert.match(wr[1], /W1 closed · the RITM status \(Dana Ruiz\)/);
	assert.match(wr[1], /❯ ✓ W1 Dana Ruiz/, "a closed wait stays listed, selected, so r can reopen it");
	assert.match(wr[1], /enter reopen · r reopen · x drop · u undo · tab back/);
	assert.match(wr[2], /❯ ⧗ W1 Dana Ruiz[\s\S]*Back · W1/);
	assert.match(wr[2], /enter close · c close · x drop/);
	assert.match(wr[3], /W1 dropped · the RITM status/);
	assert.doesNotMatch(wr[3], /Waiting on/);
	assert.match(wr[4], /❯ ⧗ W1 Dana Ruiz[\s\S]*Back · W1/, "an undone drop comes back selected");
	assert.match(wr[6], /W1 open again · the RITM status/);
	const st = JSON.parse(fs.readFileSync(path.join(dataDir, `${dayOf(NOW)}.state.json`), "utf8"));
	assert.deepEqual(st.waits.map((x) => [x.id, x.state]), [["W1", "open"]]);
	assert.deepEqual(st.droppedSigs, [], "the undo took the drop back");

	// /watch rules and unmute.
	await commands.watch.handler("unmute M2", ctx);
	assert.match(notes.at(-1), /Removed M2 · from "Pat Doe"/);
	await commands.watch.handler('mute text "certificate" in oddball for 2d', ctx);
	assert.match(notes.at(-1), /^info: Muted M3 · text "certificate" in oddball until \d{4}-\d\d-\d\d \d\d:\d\d · 0 cleared/);
});
