/**
 * Unit tests for the web_fetch ladder's JS-shell detection.
 *
 *   bin/pi-ext-check --test-only
 *   node --test .pi-agent/test/web-fetch-resilient.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { htmlToMarkdown, looksLikeJsShell } from "../extensions/web-fetch-resilient/fetch-core.ts";

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
