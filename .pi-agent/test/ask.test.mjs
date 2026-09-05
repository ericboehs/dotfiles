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

import askExtension, { buildItems, formatAnswerLines, formatRpcLabel, parseMultiPicks } from "../extensions/ask.ts";

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

async function mountTool() {
	const url = new URL("../extensions/ask.ts", import.meta.url);
	url.search = `?t=${Math.random()}`;
	let tool;
	await (await import(url.href)).default({ registerTool: (def) => (tool = def) });
	assert.ok(tool, "ask tool is registered");
	return tool;
}
