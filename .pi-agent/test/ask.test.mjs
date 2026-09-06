/**
 * Smoke tests for the ask tool.
 *
 * The UI itself needs a terminal, so this covers what rots without one: the
 * item numbering the model sees echoed back, the RPC comma-separated parser
 * (garbage in, no hang, no phantom picks), the answer formatting, and the
 * non-interactive execute paths that must error instead of prompting.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import askExtension, { buildItems, formatAnswerLines, formatRpcLabel, initialMultiValues, initialSingleValue, parseMultiPicks } from "../extensions/ask.ts";

test("buildItems numbers labels and appends the custom row", () => {
	const items = buildItems([
		{ label: "Pepperoni" },
		{ label: "Mushrooms", description: "Earthy" },
	]);
	assert.deepEqual(
		items.map((i) => [i.value, i.label]),
		[
			["0", "1. Pepperoni"],
			["1", "2. Mushrooms"],
			["__custom__", "3. Type something."],
		],
	);
	assert.equal(items[1].description, "Earthy");
});

test("parseMultiPicks tolerates separators and garbage", () => {
	assert.deepEqual(parseMultiPicks("1,3", 4), [1, 3]);
	assert.deepEqual(parseMultiPicks("2 4", 4), [2, 4]);
	assert.deepEqual(parseMultiPicks(" 1, 1, 2,", 4), [1, 2]);
	assert.deepEqual(parseMultiPicks("1,abc,99,0,-2,2.5,2", 4), [1, 2]);
	assert.deepEqual(parseMultiPicks("", 4), []);
	assert.deepEqual(parseMultiPicks("abc", 4), []);
});

test("formatAnswerLines numbers picks and appends free text", () => {
	assert.deepEqual(formatAnswerLines(["A", "B", "C"], ["A", "C"], []), ["User selected: 1. A, 3. C"]);
	assert.deepEqual(formatAnswerLines(["A", "B"], [], ["moldy cheese"]), [
		"User selected: ",
		"User wrote: moldy cheese",
	]);
});

test("initialSingle/MultiValues maps prior labels back to item values", () => {
	const opts = [{ label: "A" }, { label: "B" }, { label: "C" }];
	assert.equal(initialSingleValue(opts, ["B"]), "1");
	assert.equal(initialSingleValue(opts, []), undefined);
	assert.equal(initialSingleValue(opts, ["Stale"]), undefined);
	assert.deepEqual(initialMultiValues(opts, ["A", "C"]), ["0", "2"]);
	assert.deepEqual(initialMultiValues(opts, ["C", "Stale", "A"]), ["2", "0"]);
	assert.deepEqual(initialMultiValues(opts, []), []);
});

test("batch back re-asks the previous question and overwrites on re-answer", async () => {
	const { mod, tool } = await mountModule();
	const factories = [];
	const script = ["0", mod.BACK, "1", "0"];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (fn) => {
				factories.push(fn);
				return script.shift();
			},
			input: async () => {
				throw new Error("input should not be called");
			},
		},
	};
	const params = {
		questions: [
			{ question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2?", options: [{ label: "C" }, { label: "D" }] },
		],
	};
	const result = await tool.execute("t1", params, undefined, undefined, ctx);
	assert.equal(result.content[0].text, "Q1: Q1?\nUser selected: 2. B\nQ2: Q2?\nUser selected: 1. C");
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(
		result.details.byQuestion.map((q) => q.answers),
		[["B"], ["C"]],
	);
	assert.equal(factories.length, 4);

	// Q2 offered back + progress; shift+tab steps back.
	const q2 = drive(factories[1]);
	const q2lines = q2.comp.render(60);
	assert.ok(
		q2lines.some((l) => l.includes("Q2/2")),
		"shows progress",
	);
	assert.ok(
		q2lines.some((l) => l.includes("shift+tab/← back")),
		"hints back",
	);
	q2.comp.handleInput("\x1b[Z");
	assert.equal(q2.done(), mod.BACK);

	// Clicking the ← Back row steps back too (mouse users).
	const q2click = drive(factories[1]);
	const q2clickLines = q2click.comp.render(60);
	const backY = q2clickLines.findIndex((l) => l.includes("← Back"));
	assert.ok(backY >= 0, "back row rendered");
	q2click.comp.handleMouse({ type: "click", button: "left", y: backY });
	assert.equal(q2click.done(), mod.BACK);

	// Q1 has progress but no back affordance; left arrow is a no-op.
	const q1 = drive(factories[0]);
	const q1lines = q1.comp.render(60);
	assert.ok(q1lines.some((l) => l.includes("Q1/2")));
	assert.ok(!q1lines.some((l) => l.includes("shift+tab")));
	assert.ok(!q1lines.some((l) => l.includes("← Back")));
	q1.comp.handleInput("\x1b[D");
	assert.equal(q1.wasDone(), false);

	// Option clicks still confirm directly.
	const q1click = drive(factories[0]);
	const q1clickLines = q1click.comp.render(60);
	const optY = q1clickLines.findIndex((l) => l.includes("2. B"));
	assert.ok(optY >= 0, "option row rendered");
	q1click.comp.handleMouse({ type: "click", button: "left", y: optY });
	assert.equal(q1click.done(), "1");

	// Revisit restores the cursor to the prior pick (1. A).
	const revisit = drive(factories[2]);
	const rlines = revisit.comp.render(60);
	const aLine = rlines.find((l) => l.includes("1. A"));
	assert.ok(aLine.startsWith("→ "), `cursor on prior pick, got: ${aLine}`);
});

test("batch cancel after going back keeps only the prefix answers", async () => {
	const { mod, tool } = await mountModule();
	const script = ["0", "0", mod.BACK, undefined];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async () => script.shift(),
			input: async () => {
				throw new Error("input should not be called");
			},
		},
	};
	const params = {
		questions: [
			{ question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2?", options: [{ label: "C" }, { label: "D" }] },
			{ question: "Q3?", options: [{ label: "E" }, { label: "F" }] },
		],
	};
	const result = await tool.execute("t1", params, undefined, undefined, ctx);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.byQuestion.length, 1);
	assert.deepEqual(result.details.byQuestion[0].answers, ["A"]);
	assert.ok(result.content[0].text.includes("Q1: Q1?"));
	assert.ok(!result.content[0].text.includes("Q2:"));
});

test("batch multi back preserves checked picks for pre-fill", async () => {
	const { mod, tool } = await mountModule();
	const factories = [];
	const script = ["0", { values: ["0", "1"] }, mod.BACK, { values: ["2"] }, "1"];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (fn) => {
				factories.push(fn);
				return script.shift();
			},
			input: async () => {
				throw new Error("input should not be called");
			},
		},
	};
	const params = {
		questions: [
			{ question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
			{ question: "QM?", options: [{ label: "X" }, { label: "Y" }, { label: "Z" }], multiSelect: true },
			{ question: "Q3?", options: [{ label: "E" }, { label: "F" }] },
		],
	};
	const result = await tool.execute("t1", params, undefined, undefined, ctx);
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(
		result.details.byQuestion.map((q) => q.answers),
		[["A"], ["Z"], ["F"]],
	);
	assert.equal(factories.length, 5);

	// Multi picker at Q2 shows progress, back hint, and a clickable row.
	const qm = drive(factories[1]);
	const qmLines = qm.comp.render(60);
	assert.ok(qmLines.some((l) => l.includes("Q2/3")), "shows progress");
	assert.ok(qmLines.some((l) => l.includes("shift+tab/← back")), "hints back");
	const qmBackY = qmLines.findIndex((l) => l.includes("← Back"));
	assert.ok(qmBackY >= 0, "multi back row rendered");

	// Left arrow steps back in multi mode too.
	const qmKeys = drive(factories[1]);
	qmKeys.comp.handleInput("\x1b[D");
	assert.equal(qmKeys.done(), mod.BACK);

	// Revisited multi restores prior checks (X and Y were both picked before).
	const revisit = drive(factories[3]);
	const lines = revisit.comp.render(60);
	const xLine = lines.find((l) => l.includes("1. X"));
	const yLine = lines.find((l) => l.includes("2. Y"));
	const zLine = lines.find((l) => l.includes("3. Z"));
	assert.ok(xLine.includes("[x]"), `X still checked, got: ${xLine}`);
	assert.ok(yLine.includes("[x]"), `Y still checked, got: ${yLine}`);
	assert.ok(zLine.includes("[ ]"), `Z unchecked, got: ${zLine}`);

	// The multi picker renders a clickable ← Back row as well.
	const multiClick = drive(factories[3]);
	const mcLines = multiClick.comp.render(60);
	const mcBackY = mcLines.findIndex((l) => l.includes("← Back"));
	assert.ok(mcBackY >= 0, "multi back row rendered");
	multiClick.comp.handleMouse({ type: "click", button: "left", y: mcBackY });
	assert.equal(multiClick.done(), mod.BACK);
});
test("formatRpcLabel folds the description in", () => {
	assert.equal(formatRpcLabel("1. Mushrooms", "Earthy"), "1. Mushrooms — Earthy");
	assert.equal(formatRpcLabel("1. Pepperoni"), "1. Pepperoni");
});

test("execute maps an RPC display string back to its value", async () => {
	const tool = await mountTool();
	let shown;
	const rpc = {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: async (_title, options) => {
				shown = options;
				return options[1];
			},
			input: async () => {
				throw new Error("input should not be called");
			},
		},
	};
	const result = await tool.execute(
		"t1",
		{ question: "Which?", options: [{ label: "Pepperoni" }, { label: "Mushrooms", description: "Earthy" }] },
		undefined,
		undefined,
		rpc,
	);
	assert.deepEqual(shown, ["1. Pepperoni", "2. Mushrooms — Earthy", "3. Type something."]);
	assert.equal(result.content[0].text, "User selected: 2. Mushrooms");
	assert.deepEqual(result.details.answers, ["Mushrooms"]);
});

test("tool registers as sequential ask", async () => {
	const tool = await mountTool();
	assert.equal(tool.name, "ask");
	assert.equal(tool.executionMode, "sequential");
});

test("execute errors instead of prompting without UI or params", async () => {
	const tool = await mountTool();
	const noUI = { hasUI: false, mode: "print", ui: {} };

	const noOptions = await tool.execute("t1", { question: "Q?", options: [] }, undefined, undefined, noUI);
	assert.match(noOptions.content[0].text, /no options/);
	assert.equal(noOptions.details.cancelled, true);

	const noUIResult = await tool.execute("t1", { question: "Q?", options: [{ label: "A" }] }, undefined, undefined, noUI);
	assert.match(noUIResult.content[0].text, /UI unavailable/);

	const noParams = await tool.execute("t1", {}, undefined, undefined, noUI);
	assert.match(noParams.content[0].text, /question\+options or questions/);
});

async function mountModule() {
	const url = new URL("../extensions/ask.ts", import.meta.url);
	url.search = `?t=${Math.random()}`;
	const mod = await import(url.href);
	let tool;
	await mod.default({ registerTool: (def) => (tool = def) });
	assert.ok(tool, "ask tool is registered");
	return { mod, tool };
}

async function mountTool() {
	const { tool } = await mountModule();
	return tool;
}

/** Drive a captured ctx.ui.custom factory with fake TUI/theme and a done spy. */
function drive(factory) {
	const tui = { requestRender() {} };
	const theme = { fg: (_c, t) => t };
	let result;
	let called = false;
	const comp = factory(tui, theme, {}, (v) => {
		called = true;
		result = v;
	});
	return { comp, done: () => result, wasDone: () => called };
}
