/**
 * Test harness — exercises resilientFetch directly (no pi needed):
 *   node test.ts [url ...]
 */
import { resilientFetch, shutdownBrowser } from "./fetch-core.ts";

const DEFAULT_URLS = [
	"https://example.com/", // sanity: tier 1
	"https://www.theverge.com/apple/index.html", // today's failure case
	"https://www.theverge.com/tech/984207/apple-mac-studio-m5-max-ultra-price-specs-launch", // the M5 Ultra article
	"https://www.tractorsupply.com/", // Akamai-protected
];

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;

for (const url of urls) {
	console.log(`\n=== ${url} ===`);
	const t0 = Date.now();
	try {
		const r = await resilientFetch(url, { maxChars: 3000 });
		console.log(`tier ${r.tier} | status ${r.status} | ${Date.now() - t0}ms | final: ${r.finalUrl}`);
		console.log(r.content.slice(0, 400).replace(/\n{3,}/g, "\n\n"));
		console.log("...");
	} catch (e) {
		console.error(`FAILED (${Date.now() - t0}ms):\n${(e as Error).message}`);
	}
}

await shutdownBrowser();
