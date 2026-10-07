/**
 * Tests for what runSearchChain hands the model: the footer naming the backend
 * that answered, and Brave's quota folded into it. Runs the real chain against
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
writeFileSync(join(agentDir, "web.json"), JSON.stringify({ search: { order: ["brave", "tavily"] } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.BRAVE_AI_API_KEY = "test-brave";
process.env.TAVILY_API_KEY = "test-tavily";

const { clearSkips } = await import("../extensions/web-providers/config.ts");
const { runSearchChain } = await import("../extensions/web-providers/search.ts");

const realFetch = globalThis.fetch;
const deps = { codex: async () => ({ hits: [] }) };
const hit = { title: "curl -L", url: "https://curl.se/docs/manpage.html" };

/** Route by host; `brave` may be a Response to return or a status to fail with. */
function stubFetch({ brave }) {
	globalThis.fetch = async (url) => {
		const host = new URL(String(url)).host;
		if (host === "api.search.brave.com") {
			if (typeof brave === "number") return new Response("boom", { status: brave });
			return brave;
		}
		if (host === "api.tavily.com") {
			return Response.json({ results: [{ ...hit, content: "Follow redirects with -L." }] });
		}
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
	stubFetch({
		brave: Response.json(
			{ web: { results: [{ ...hit, description: "Follow redirects with -L." }] } },
			{ headers: { "x-ratelimit-remaining": "0, 1930", "x-ratelimit-limit": "1, 2000" } },
		),
	});
	const out = await runSearchChain("curl follow redirects", {}, deps);
	assert.equal(out.backend, "brave");
	assert.match(out.text, /\n\n---\n\[via brave · 1,930 of 2,000 left this month\]$/);
});

test("a failover names the backend that answered, not the one that was first", async () => {
	stubFetch({ brave: 500 });
	const out = await runSearchChain("curl follow redirects", {}, deps);
	assert.equal(out.backend, "tavily");
	assert.match(out.text, /\n\n---\n\[via tavily\]$/);
	assert.equal(out.tried.length, 1);
});
