/**
 * meeting.ts on VA Copilot only: the scout, /q research, the prompt cap, and
 * the code rules that carry on when no VA Copilot model answers.
 *
 * Its own file so the env is set before meeting.ts reads it at import.
 *
 * Run: node --test .pi-agent/test/meeting-work.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-work-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(process.env, {
	PI_MEETING_DIR: dir,
	PI_MEETING_QMD_COLLECTIONS: "",
	PI_MEETING_DAILY_DIR: "",
	PI_MEETING_ABOUT: path.join(dir, "no-about.md"),
	PI_MEETING_ME: "Eric Boehs",
});
delete process.env.PI_MEETING_MODEL;
delete process.env.PI_MEETING_RESEARCH_MODEL;

const { default: meeting, buildUserPrompt, fitUserPrompt, researchModel, ruleAlert, widgetLines } = await import("../extensions/meeting.ts");
const { estTokens, isWorkModel, modelSpecs, PERSONAL_MODELS, PROMPT_MAX_TOKENS, WORK_MODELS, WORK_RESEARCH_MODEL, workOnly } = await import(
	"../extensions/watch/models.ts"
);

const plain = { fg: (_color, s) => s };

// ── which models ──

test("only VA Copilot may read work text", () => {
	assert.deepEqual(WORK_MODELS, ["github-copilot/claude-haiku-5.5"]);
	assert.ok(WORK_MODELS.every(isWorkModel) && isWorkModel(WORK_RESEARCH_MODEL));
	assert.ok(!PERSONAL_MODELS.some(isWorkModel), "DeepSeek and GLM are personal only");
	assert.deepEqual(workOnly(["opencode-go/deepseek-v4.1-flash", "github-copilot/claude-haiku-5.5", "openrouter/anthropic/claude"]), {
		ok: ["github-copilot/claude-haiku-5.5"],
		refused: ["opencode-go/deepseek-v4.1-flash", "openrouter/anthropic/claude"],
	});
	assert.ok(isWorkModel("GitHub-Copilot/claude-haiku-5.5"));
	assert.ok(!isWorkModel("claude-haiku-5.5"), "no provider, no pass");
	assert.deepEqual(modelSpecs(" a/b, c  d/e "), ["a/b", "d/e"]);
	assert.deepEqual(modelSpecs(undefined), []);
});

test("meeting.ts names no model outside VA Copilot", () => {
	const src = fs.readFileSync(fileURLToPath(new URL("../extensions/meeting.ts", import.meta.url)), "utf8");
	assert.doesNotMatch(src, /deepseek|opencode|glm-|openrouter/i);
});

test("/q research: the configured model or the session's if on VA Copilot, else Opus there", () => {
	assert.deepEqual(researchModel("github-copilot/claude-haiku-5.5", "github-copilot/claude-opus-5.5"), { model: "github-copilot/claude-haiku-5.5", refused: "" });
	assert.deepEqual(researchModel("", "github-copilot/claude-opus-5.5"), { model: "github-copilot/claude-opus-5.5", refused: "" });
	assert.deepEqual(researchModel("", "opencode-go/deepseek-v4.1-flash"), { model: WORK_RESEARCH_MODEL, refused: "opencode-go/deepseek-v4.1-flash" });
	assert.deepEqual(researchModel("anthropic/claude-opus-5.5", "github-copilot/claude-opus-5.5"), { model: WORK_RESEARCH_MODEL, refused: "anthropic/claude-opus-5.5" });
	assert.deepEqual(researchModel("", ""), { model: WORK_RESEARCH_MODEL, refused: "" });
});

// ── the prompt cap ──

const input = (lines) => ({
	title: "EERT Weekly Sync",
	app: "Teams",
	people: [],
	lines,
	newFrom: Math.max(0, lines.length - 5),
	open: [],
	focus: "",
	cue: null,
	me: "Eric Boehs",
	now: new Date(2026, 9, 7, 10, 30),
});
const talk = (n) => Array.from({ length: n }, (_, i) => `[10:${String(i % 60).padStart(2, "0")}:00] Speaker ${i % 7}: ${"some words here ".repeat(5)}line ${i}`);

test("a short meeting's prompt is untouched", () => {
	const p = input(talk(10));
	assert.equal(fitUserPrompt("system", p), buildUserPrompt(p));
});

test("a long meeting keeps its newest lines and stays under the cap", () => {
	const p = input(talk(4000));
	const system = "s".repeat(120_000); // a big background: ~40k tokens
	const user = fitUserPrompt(system, p);
	assert.ok(estTokens(system) + estTokens(user) <= PROMPT_MAX_TOKENS, `${estTokens(system) + estTokens(user)} tokens`);
	assert.match(user, /line 3999\n<\/transcript>/, "the newest line stays");
	assert.match(user, /<transcript>\n\[… earlier lines omitted …\]\n/);
	assert.ok(estTokens(buildUserPrompt(p)) > estTokens(user), "trimmed below the plain cap");
});

test("when even the background is too big, the transcript shrinks to its marker", () => {
	const user = fitUserPrompt("s".repeat(120_000), input(talk(50)), 1000);
	assert.match(user, /<transcript>\n\[… earlier lines omitted …\]\n<\/transcript>/);
});

// ── rules ──

test("ruleAlert says who named you or asked for questions, clipped", () => {
	assert.equal(ruleAlert("mention", { speaker: "Lindsey Hattamer", text: "Eric, can you  take this one?" }), 'Lindsey Hattamer named you: "Eric, can you take this one?"');
	assert.equal(ruleAlert("invite", { speaker: "Alex Teal", text: "Any questions?" }), 'Alex Teal asked for questions: "Any questions?"');
	assert.equal(ruleAlert("mention", undefined), "Someone named you");
	assert.equal(ruleAlert(null, { speaker: "A", text: "b" }), "");
	const long = ruleAlert("mention", { speaker: "A", text: "x".repeat(300) });
	assert.ok(long.endsWith('…"') && long.length < 170);
});

test("widget: rules only in place of the check count, and the alert below", () => {
	const view = {
		phase: "live",
		title: "EERT Weekly Sync",
		filter: "",
		startedMs: 0,
		topic: "",
		checks: 0,
		cost: 0,
		busy: false,
		error: "",
		questions: [],
		shown: [],
		expanded: false,
		reply: "",
		replay: false,
		endsAt: 0,
		rulesOnly: true,
		alert: 'Alex Teal asked for questions: "Any questions?"',
	};
	assert.deepEqual(widgetLines(view, plain, 120), [
		"● meeting · EERT Weekly Sync · rules only · /meeting stop",
		'  ! Alex Teal asked for questions: "Any questions?"',
	]);
});

// ── the extension ──

test("/meeting with a DeepSeek --model and no VA Copilot credentials: refused, rules only, no model called", async (t) => {
	const file = path.join(dir, "20261007_100000-teams-eert-weekly-sync.jsonl");
	fs.writeFileSync(
		file,
		[
			{ type: "metadata", meeting: "EERT Weekly Sync", app: "Teams", meeting_started_at: "2026-10-07T10:00:00-05:00" },
			{ type: "caption", ts: "2026-10-07T10:00:01-05:00", speaker: "Alex Teal", text: "Runner migration is on track." },
			{ type: "caption", ts: "2026-10-07T10:00:02-05:00", speaker: "Lindsey Hattamer", text: "Eric, can you take the Dynatrace piece?" },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
	const commands = {};
	const sent = [];
	const notes = [];
	const found = [];
	const widgets = [];
	let called = 0;
	meeting({
		on: () => {},
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		sendMessage: (m) => sent.push(m),
	});
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
		modelRegistry: {
			find: (provider, id) => (found.push(`${provider}/${id}`), { provider, id, name: id }),
			hasConfiguredAuth: () => false,
			streamSimple: () => {
				called++;
				throw new Error("no model may be called");
			},
		},
		ui: {
			notify: (m, level) => notes.push(`${level ?? "info"}: ${m}`),
			setWidget: (_key, factory) => widgets.push(factory ? factory(null, plain).render(160) : undefined),
		},
	};
	t.after(() => commands.meeting.handler("stop", ctx));
	await commands.meeting.handler(`start ${file} --replay 100 --model opencode-go/deepseek-v4.1-flash`, ctx);

	const alert = '  ! Lindsey Hattamer named you: "Eric, can you take the Dynatrace piece?"';
	const end = Date.now() + 8000;
	while (!widgets.some((w) => w?.includes(alert))) {
		assert.ok(Date.now() < end, `no alert in the widget; notes: ${notes.join(" | ")}`);
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(notes.includes("warning: Not VA Copilot, so never given meeting text: opencode-go/deepseek-v4.1-flash"), notes.join(" | "));
	assert.ok(notes.some((n) => n.startsWith("warning: No VA Copilot scout with credentials (none given); cues by rule only")), notes.join(" | "));
	assert.deepEqual(found, [], "the registry was never asked for a non-VA model");
	assert.equal(called, 0, "no model call in rules-only mode");
	assert.match(sent[0].content, /via rules only/);
	assert.match(widgets.find((w) => w?.includes(alert))[0], /rules only/);
});

test("/meeting with Haiku failing: only Haiku is tried, the cue still shows by rule, the error says why", async (t) => {
	const file = path.join(dir, "20261007_110000-teams-platform-sync.jsonl");
	fs.writeFileSync(
		file,
		[
			{ type: "metadata", meeting: "Platform Sync", app: "Teams", meeting_started_at: "2026-10-07T11:00:00-05:00" },
			{ type: "caption", ts: "2026-10-07T11:00:01-05:00", speaker: "Alex Teal", text: "That's the plan. Any questions?" },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
	const commands = {};
	const asked = [];
	const widgets = [];
	meeting({
		on: () => {},
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		sendMessage: () => {},
	});
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
		modelRegistry: {
			find: (provider, id) => ({ provider, id, name: id }),
			hasConfiguredAuth: (m) => m.provider === "github-copilot",
			streamSimple: (m) => {
				asked.push(`${m.provider}/${m.id}`);
				return { result: async () => ({ stopReason: "error", errorMessage: "429 rate limited", content: [], usage: { cost: { total: 0 } } }) };
			},
		},
		ui: { notify: () => {}, setWidget: (_key, factory) => widgets.push(factory ? factory(null, plain).render(200) : undefined) },
	};
	t.after(() => commands.meeting.handler("stop", ctx));
	await commands.meeting.handler(`start ${file} --replay 100`, ctx);

	const alert = '  ! Alex Teal asked for questions: "That\'s the plan. Any questions?"';
	const end = Date.now() + 8000;
	while (!widgets.some((w) => w?.includes(alert))) {
		assert.ok(Date.now() < end, "no alert in the widget");
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(asked.length >= 1 && asked.every((s) => s === "github-copilot/claude-haiku-5.5"), asked.join(", "));
	assert.match(widgets.find((w) => w?.includes(alert))[0], /error: github-copilot\/claude-haiku-5\.5: 429 rate limited/);
});
