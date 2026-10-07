/**
 * Tests for what runSearchChain hands the model: the footer naming the backend
 * that answered, the ones that failed before it, and Brave's quota. Runs the real chain against
 * a stubbed fetch and a throwaway agent dir, so no key or network is touched.
 *
 *   bin/pi-ext-check --test-only
 *   node --test .pi-agent/test/web-search-chain.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Before the first loadConfig: the config module caches whatever it reads.
const agentDir = mkdtempSync(join(tmpdir(), "web-search-chain-"));
writeFileSync(join(agentDir, "web.json"), JSON.stringify({ search: { order: ["brave", "tavily", "exa"] } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.BRAVE_AI_API_KEY = "test-brave";
process.env.TAVILY_API_KEY = "test-tavily";
process.env.EXA_API_KEY = "test-exa";
process.env.PERPLEXITY_API_KEY = "test-perplexity";

const { clearSkips } = await import("../extensions/web-providers/config.ts");
const { runSearchChain } = await import("../extensions/web-providers/search.ts");

const realFetch = globalThis.fetch;
const deps = { codex: async () => ({ hits: [] }) };
const hit = { title: "curl -L", url: "https://curl.se/docs/manpage.html" };

const braveOk = () =>
	Response.json(
		{ web: { results: [{ ...hit, description: "Follow redirects with -L." }] } },
		{ headers: { "x-ratelimit-remaining": "0, 1930", "x-ratelimit-limit": "1, 2000" } },
	);

/** Every backend answers unless overridden with a status to fail with. */
function stubFetch(fail = {}) {
	const ok = {
		"api.search.brave.com": braveOk,
		"api.tavily.com": () => Response.json({ results: [{ ...hit, content: "Follow redirects with -L." }] }),
		"api.exa.ai": () => Response.json({ results: [{ ...hit, highlights: ["Follow redirects with -L."] }] }),
	};
	globalThis.fetch = async (url) => {
		const host = new URL(String(url)).host;
		if (fail[host]) return new Response("boom", { status: fail[host] });
		if (ok[host]) return ok[host]();
		throw new Error(`unexpected fetch: ${url}`);
	};
}

beforeEach(async () => {
	await clearSkips(); // a failure in one test benches brave for the next
});

after(() => {
	globalThis.fetch = realFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

test("the footer names the backend and carries Brave's live quota", async () => {
	stubFetch();
	const out = await runSearchChain("curl follow redirects", {}, deps);
	assert.equal(out.backend, "brave");
	assert.match(out.text, /\n\n---\n\[via brave · 1,930 of 2,000 left this month\]$/);
});

test("a failover names the backend that answered and the one that failed", async () => {
	stubFetch({ "api.search.brave.com": 500 });
	const out = await runSearchChain("curl follow redirects", {}, deps);
	assert.equal(out.backend, "tavily");
	assert.match(out.text, /\n\n---\n\[via tavily · brave failed\]$/);
	assert.equal(out.tried.length, 1);
});

test("several failures are listed in the order they were tried", async () => {
	stubFetch({ "api.search.brave.com": 500, "api.tavily.com": 432 });
	const out = await runSearchChain("curl follow redirects", {}, deps);
	assert.equal(out.backend, "exa");
	assert.match(out.text, /\[via exa · brave, tavily failed\]$/);
});

test("a hard search that fell through says the deep tier did not answer", async () => {
	stubFetch({ "api.perplexity.ai": 429 });
	const out = await runSearchChain("curl follow redirects", { hard: true }, deps);
	assert.equal(out.backend, "brave");
	// Failures and quota share the line, failures first: they explain the "via".
	assert.match(out.text, /\[via brave · perplexity failed · 1,930 of 2,000 left this month\]$/);
});
