/**
 * Re-runnable quality eval for the web_fetch tier ladder.
 *
 *   node --experimental-strip-types eval.ts                 # free headless tiers
 *   node --experimental-strip-types eval.ts --all           # + firecrawl (credits) + safari (GUI)
 *   node --experimental-strip-types eval.ts --tiers chrome,tinyfish
 *
 * The search-side counterpart is ../web-providers/eval.mjs. That one mirrors
 * search.ts's rendering by hand; this one does not have to, because
 * resilientFetch already returns the finished, extracted, truncated string.
 * Measuring anything earlier than that is measuring the wrong boundary: a raw
 * API payload flatters whichever backend sends the most bytes, and the bytes
 * that never survive extraction are bytes the model never sees.
 *
 * A tier is forced by handing resilientFetch a one-name order. That is the
 * real code path, not something adjacent to it.
 */
import { resilientFetch, shutdownBrowser, TIER_NUMBERS, type FetchTierName } from "./fetch-core.ts";

const FREE_HEADLESS: FetchTierName[] = ["plain", "curl", "chrome", "tinyfish"];
const PAID_OR_VISIBLE: FetchTierName[] = ["firecrawl", "safari"];

/**
 * Ground truth is a string that is really on the page and really stable, so a
 * miss means the tier failed to retrieve or failed to extract — never that the
 * fact moved. Ordered roughly by how hard the page fights back.
 *
 * Each string must also appear within the 20K truncation window, or the eval
 * measures truncation instead of retrieval: Wikipedia's "object-relational"
 * lead sits behind a long infobox and falls outside it, which is a property of
 * the budget, not of any tier.
 *
 * Reddit is checked for a `u/handle` rather than the subreddit name on purpose.
 * Every tier can scrape the title out of a bot wall; only a tier that actually
 * rendered the feed comes back with post authors in it. A marker the failing
 * tiers can satisfy would score the wall as a success. Glassdoor is checked
 * for a `media.glassdoor.com` asset URL and Hacker News for a score, for the
 * same reason.
 *
 * Hostile pages are stochastic: Chrome has thrown on pages it fetched minutes
 * earlier, because bot scoring is not a pure function of the request. Treat a
 * single run as one sample, and re-run before concluding a tier regressed.
 */
const CASES: Array<{ url: string; want: RegExp; note: string }> = [
  // --- controls: everything should pass these ---
  { url: "https://example.com/", want: /documentation examples/i, note: "static, 1.2KB" },
  { url: "https://en.wikipedia.org/wiki/PostgreSQL", want: /PostgreSQL Global Development Group/i, note: "large static article" },
  { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429", want: /too many requests/i, note: "docs" },
  { url: "https://news.ycombinator.com/", want: /\d+\s+points?/i, note: "server HTML; marker needs the feed" },

  // --- client-rendered ---
  { url: "https://artificialanalysis.ai/models/glm-5-3-flash/providers", want: /0\.15/, note: "JS SPA" },
  { url: "https://www.zillow.com/", want: /recommendations are based/i, note: "JS SPA + PerimeterX" },

  // --- bot walls, roughly ascending ---
  { url: "https://www.tractorsupply.com/", want: /tractor supply/i, note: "Akamai sensor" },
  { url: "https://www.indeed.com/", want: /find salaries/i, note: "Cloudflare" },
  { url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array", want: /branch pred/i, note: "Cloudflare; 113KB when it works" },
  { url: "https://www.reddit.com/r/programming/", want: /\bu\/[A-Za-z0-9_-]{3,}/, note: "JS shell + bot wall" },
  { url: "https://www.bloomberg.com/", want: /businessweek/i, note: "aggressive wall + paywall" },
  { url: "https://www.g2.com/categories/crm", want: /CRM Software/i, note: "403s datacenter IPs" },
  { url: "https://www.glassdoor.com/Reviews/index.htm", want: /media\.glassdoor\.com/i, note: "blocks datacenter IPs outright" },
];

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

let tiers: FetchTierName[] = flag("--all") ? [...FREE_HEADLESS, ...PAID_OR_VISIBLE] : [...FREE_HEADLESS];
const explicit = value("--tiers");
if (explicit) {
  tiers = explicit.split(",").map((s) => s.trim()) as FetchTierName[];
  const bad = tiers.filter((t) => !(t in TIER_NUMBERS));
  if (bad.length) {
    console.error(`unknown tier(s): ${bad.join(", ")}\nvalid: ${Object.keys(TIER_NUMBERS).join(", ")}`);
    process.exit(1);
  }
}

// Keys are read here and handed down, so fetch-core keeps owning no secrets.
const { resolveKey } = await import("../web-providers/config.ts");
const firecrawlKey = tiers.includes("firecrawl") ? await resolveKey("firecrawl") : undefined;
const tinyfishKey = tiers.includes("tinyfish") ? await resolveKey("tinyfish") : undefined;

interface Row {
  tier: FetchTierName;
  hits: number;
  shells: number;
  fails: number;
  chars: number;
  ms: number;
}

const rows: Row[] = [];
const detail: Record<string, string[]> = {};

console.log(`\n${CASES.length} URLs x ${tiers.length} tiers = ${CASES.length * tiers.length} fetches`);
console.log(`tiers: ${tiers.join(", ")}${tiers.includes("firecrawl") ? "  (firecrawl spends 1 credit per URL)" : ""}\n`);

for (const tier of tiers) {
  let hits = 0;
  let shells = 0;
  let fails = 0;
  let chars = 0;
  let ms = 0;
  const notes: string[] = [];

  for (const { url, want } of CASES) {
    const t0 = Date.now();
    let text = "";
    try {
      const r = await resilientFetch(url, {
        order: [tier],
        firecrawlKey,
        tinyfishKey,
        maxChars: 20_000,
      });
      text = r.content;
      // resilientFetch hands back the fullest shell rather than throwing when
      // every tier extracts nothing. For scoring that is a failure with extra
      // steps, so count it separately instead of letting it look like content.
      if (/WARNING: no readable content extracted/.test(text)) {
        shells++;
        notes.push(`${new URL(url).hostname} (shell)`);
      }
    } catch (e) {
      fails++;
      notes.push(`${new URL(url).hostname} (${(e as Error).message.split("\n")[0].slice(0, 48)})`);
    }
    ms += Date.now() - t0;
    chars += text.length;
    if (want.test(text)) hits++;
    else if (text && !/WARNING: no readable content/.test(text)) notes.push(`${new URL(url).hostname} (no match)`);
  }

  rows.push({
    tier,
    hits,
    shells,
    fails,
    chars: Math.round(chars / CASES.length),
    ms: Math.round(ms / CASES.length),
  });
  detail[tier] = notes;
  console.log(`  ${tier} done`);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

console.log(`\n${pad("tier", 11)}${lpad("correct", 8)}${lpad("shell", 7)}${lpad("fail", 6)}${lpad("avg chars", 11)}${lpad("avg ms", 8)}`);
for (const r of rows) {
  console.log(
    `${pad(r.tier, 11)}${lpad(`${r.hits}/${CASES.length}`, 8)}${lpad(r.shells, 7)}${lpad(r.fails, 6)}${lpad(r.chars, 11)}${lpad(r.ms, 8)}`,
  );
}

console.log("\nper-tier misses:");
for (const [tier, notes] of Object.entries(detail)) {
  if (notes.length) console.log(`  ${tier}: ${notes.join(" | ")}`);
}

await shutdownBrowser();
