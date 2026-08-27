/**
 * Tests for Brave quota parsing used by web_search.
 *
 *   bin/pi-ext-check --test-only
 *   node --test .pi-agent/test/web-search.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseBraveMonthlyRemaining } from "../extensions/web-providers/search.ts";

test("parses monthly remaining from Brave's paired header", () => {
	assert.equal(parseBraveMonthlyRemaining("0, 1985"), 1985);
	assert.equal(parseBraveMonthlyRemaining("1, 2000"), 2000);
	assert.equal(parseBraveMonthlyRemaining("0, 0"), 0);
});

test("treats a missing or malformed header as unknown, not spent", () => {
	assert.equal(parseBraveMonthlyRemaining(null), undefined);
	assert.equal(parseBraveMonthlyRemaining(""), undefined);
	assert.equal(parseBraveMonthlyRemaining("0"), undefined);
	assert.equal(parseBraveMonthlyRemaining("n/a, n/a"), undefined);
});
