/**
 * Unit tests for the web_fetch ladder's JS-shell detection.
 *
 *   bin/pi-ext-check --test-only
 *   node --test .pi-agent/test/web-fetch-resilient.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	htmlToMarkdown,
	looksLikeAuthWall,
	looksLikeJsShell,
	thinFloor,
} from "../extensions/web-fetch-resilient/fetch-core.ts";

// Captured 2026-08-26 from
// https://www.gatesnotes.com/a-turbulent-ai-era-and-critical-choices-to-make
// via plain fetch: 200, 2103 bytes, empty #__next, empty pageProps.
const GATES_SHELL = `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title></title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/[...page]","query":{},"buildId":"pysia2GYBw8wm9Wn6YjkY","nextExport":true,"autoExport":true,"isFallback":false,"scriptLoader":[]}</script></body></html>`;

test("empty Next.js export is a JS shell", () => {
	assert.equal(looksLikeJsShell(GATES_SHELL), true);
});

test("example.com is not a JS shell", () => {
	const html = `<!doctype html><html><head><title>Example Domain</title></head><body>
		<h1>Example Domain</h1>
		<p>This domain is for use in illustrative examples in documents.</p>
	</body></html>`;
	assert.equal(looksLikeJsShell(html), false);
});

test("Next.js SSG with content in #__next is not a shell", () => {
	const html = `<div id="__next"><article><h1>Hello</h1><p>Real rendered content.</p></article></div><script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script>`;
	assert.equal(looksLikeJsShell(html), false);
});

test("empty #root with no prose is a JS shell", () => {
	const html = `<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
	assert.equal(looksLikeJsShell(html), true);
});

test("htmlToMarkdown does not treat __NEXT_DATA__ JSON as the article", async () => {
	const md = await htmlToMarkdown(GATES_SHELL, "https://www.gatesnotes.com/x");
	assert.doesNotMatch(md, /pageProps/);
	assert.doesNotMatch(md, /__NEXT_DATA__/);
});

// --- thin() predicates -------------------------------------------------
// Captured 2026-08-28 via headless Chrome, verbatim including link markup —
// the URLs are most of the length, so a paraphrase does not reproduce the bug.
// Both were accepted as the page by the flat 200-character floor, ending the
// ladder one tier above TinyFish, which renders both. This is that regression.
// Reddit is the leading 297 chars of a 321-char body.
const REDDIT_WALL =
	"Join the most real place on the internet  Sign in with Apple Continue with Phone Number Continue with Email By continuing, you agree to our [User Agreement](https://www.redditinc.com/policies/user-agreement) and acknowledge that you understand the [Privacy Policy](https://www.redditinc.com/policies";
const INDEED_WALL =
	"Keyword : all jobs &nbsp; Edit location input box label ## Your next job starts here Create an account or sign in to see your personalized job recommendations. &nbsp; Indeed tambi\u00e9n est\u00e1 disponible en [espa\u00f1ol](https://www.indeed.com/setprefs?action=set&hl=es&prevhl=en)";

test("a federated sign-in box is an auth wall, not the page", () => {
	assert.equal(looksLikeAuthWall(REDDIT_WALL), true);
	assert.equal(looksLikeAuthWall(INDEED_WALL), true);
});

test("both walls clear the old flat floor, which is why it moved", () => {
	assert.ok(REDDIT_WALL.length > 200);
	assert.ok(INDEED_WALL.length > 200);
});

test("a long article mentioning a sign-in link is not an auth wall", () => {
	const article = `${"Real prose about federated identity. ".repeat(80)} Sign in with Google to comment.`;
	assert.ok(article.length > 2000);
	assert.equal(looksLikeAuthWall(article), false);
});

test("thin floor scales with document size and stays clamped", () => {
	assert.equal(thinFloor(1_200), 200); // example.com: floor never drops below 200
	assert.equal(thinFloor(60_000), 200); // 60_000/300 = 200, the hinge
	assert.equal(thinFloor(150_000), 500);
	assert.equal(thinFloor(5_000_000), 1_000); // ceiling: terse pages stay valid
});

test("the walls fall under the floor their own page size implies", () => {
	// Both pages are far over 150KB of HTML, so the floor is 500+.
	assert.ok(REDDIT_WALL.length < thinFloor(150_000));
	assert.ok(INDEED_WALL.length < thinFloor(150_000));
});
