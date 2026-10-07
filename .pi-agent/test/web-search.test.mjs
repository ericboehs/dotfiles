/**
 * Tests for Brave quota parsing and 429 classification used by web_search.
 *
 *   bin/pi-ext-check --test-only
 *   node --test .pi-agent/test/web-search.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cooloffForStatus, costLabel, parseBraveMonthly, quotaLeft } from "../extensions/web-providers/search.ts";

test("reads the monthly half of Brave's paired remaining and limit headers", () => {
	assert.equal(parseBraveMonthly("0, 1985"), 1985);
	assert.equal(parseBraveMonthly("1, 2000"), 2000);
	assert.equal(parseBraveMonthly("0, 0"), 0);
});

test("treats a missing or malformed header as unknown, not spent", () => {
	assert.equal(parseBraveMonthly(null), undefined);
	assert.equal(parseBraveMonthly(""), undefined);
	assert.equal(parseBraveMonthly("0"), undefined);
	assert.equal(parseBraveMonthly("n/a, n/a"), undefined);
});

test("quota reads as a count of a total, or a bare count without one", () => {
	assert.equal(quotaLeft(1930, 2000), "1,930 of 2,000 left");
	assert.equal(quotaLeft(0, 2000), "0 of 2,000 left");
	assert.equal(quotaLeft(1930), "1,930 left");
});

test("a live count replaces the static allowance in the /web test cost cell", () => {
	assert.equal(costLabel({ backend: "brave", remaining: 1930, limit: 2000 }), "1 req · 1,930 of 2,000 left");
	assert.equal(costLabel({ backend: "brave", remaining: 0 }), "1 req · 0 left");
	// No headers (failed probe, or a backend that never reports) keeps the plan.
	assert.equal(costLabel({ backend: "brave" }), "1 req · 2,000 free/mo");
	assert.equal(costLabel({ backend: "perplexity" }), "~$0.004 · no free tier");
});

const DAY = 24 * 60 * 60 * 1000;

// Verbatim from the 2026-10-06 failure: two parallel `hard` calls right after
// the paid eval's twenty benched the deep tier for a day.
const PERPLEXITY_PACE_429 =
	'{"error":{"message":"Request rate limit exceeded, please try again later.","type":"request_rate_limit_exceeded","code":429}}';

// Brave's monthly-quota 429 uses the same English. It must stay a day.
const BRAVE_QUOTA_429 =
	'{"type":"ErrorResponse","error":{"code":"RATE_LIMITED","detail":"Request rate limit exceeded for plan.","status":429}}';

test("Perplexity's per-minute 429 is a short bench, not a spent quota", () => {
	const ms = cooloffForStatus(429, PERPLEXITY_PACE_429);
	assert.ok(ms > 0, "still benched for the rest of the burst");
	assert.ok(ms <= 5 * 60 * 1000, `expected minutes at most, got ${ms}ms`);
});

test("every other 429 keeps the day-long bench", () => {
	assert.equal(cooloffForStatus(429, ""), DAY);
	assert.equal(cooloffForStatus(429, BRAVE_QUOTA_429), DAY);
});

test("the pace match is 429-only: the same body on another status means that status", () => {
	assert.equal(cooloffForStatus(402, PERPLEXITY_PACE_429), DAY);
	assert.equal(cooloffForStatus(403, PERPLEXITY_PACE_429), DAY);
});
