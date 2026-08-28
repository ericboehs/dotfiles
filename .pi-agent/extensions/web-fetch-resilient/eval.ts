/**
 * Re-runnable quality eval for the web_fetch tier ladder.
 *
 *   node --experimental-strip-types eval.ts                 # free headless tiers, in isolation
 *   node --experimental-strip-types eval.ts --all           # + firecrawl (credits) + safari (GUI)
 *   node --experimental-strip-types eval.ts --tiers chrome,tinyfish
 *   node --experimental-strip-types eval.ts --ladder        # the real ladder, escalating
 *
 * Two modes, and they answer different questions. The default forces one tier
 * at a time to score each in isolation. `--ladder` runs the configured order
 * end to end and reports which tier actually answered, which is the number
 * that matters in production — isolated scores can only suggest what the union
 * will do, and tiers that fail on disjoint pages make that suggestion
 * misleading in the optimistic direction.
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
import {
  resilientFetch,
  shutdownBrowser,
  TIER_NUMBERS,
  type FetchTierName,
} from "./fetch-core.ts";

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
 *
 * Every URL here has been confirmed live and every marker confirmed reachable
 * by at least one tier, except the Instagram row, which is deliberately a
 * ceiling. That check is not free ceremony: an earlier draft used a dead ASIN
 * whose 404 page reads "Continue shopping", which looks exactly like a bot
 * wall and would have been recorded as one.
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
  { url: "https://www.tractorsupply.com/", want: /outdoor power equipment|fencing & gates/i, note: "Akamai; nav-only page, marker proves a real render" },
  { url: "https://www.indeed.com/", want: /find salaries/i, note: "Cloudflare" },
  { url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array", want: /branch pred/i, note: "Cloudflare; 113KB when it works" },
  { url: "https://www.reddit.com/r/programming/", want: /\bu\/[A-Za-z0-9_-]{3,}/, note: "JS shell + bot wall" },
  { url: "https://www.bloomberg.com/", want: /businessweek/i, note: "aggressive wall + paywall" },
  { url: "https://www.g2.com/categories/crm", want: /CRM Software/i, note: "403s datacenter IPs" },
  { url: "https://www.glassdoor.com/Reviews/index.htm", want: /media\.glassdoor\.com/i, note: "blocks datacenter IPs outright" },
  { url: "https://www.amazon.com/dp/B09B93ZDG4", want: /echo dot/i, note: "bot-protected commerce" },
  { url: "https://www.linkedin.com/jobs/search/?keywords=rust", want: /rust jobs|open roles/i, note: "redirects some clients to a signup wall" },

  // --- ceiling: no tier has reached the actual content ---
  { url: "https://www.instagram.com/nasa/", want: /\d+ likes|view all \d+ comments/i, note: "ceiling: profile chrome renders, posts never do" },
];

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const LADDER = flag("--ladder");

// Keys are read here and handed down, so fetch-core keeps owning no secrets.
const { resolveKey, loadConfig, activeChain } = await import("../web-providers/config.ts");

let tiers: FetchTierName[];
if (LADDER) {
  // The ladder test has to run the order that actually ships, so it reads the
  // persisted config rather than a curated list. Safari still needs opting
  // into: thirteen GUI windows is not a diagnostic anyone runs twice.
  const cfg = await loadConfig();
  const live = activeChain(cfg.fetch.order, cfg.fetch.off, cfg.skipUntil) as FetchTierName[];
  tiers = flag("--all") ? live : live.filter((t) => t !== "safari");
} else {
  tiers = flag("--all") ? [...FREE_HEADLESS, ...PAID_OR_VISIBLE] : [...FREE_HEADLESS];
}
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
const firecrawlKey = tiers.includes("firecrawl") ? await resolveKey("firecrawl") : undefined;
const tinyfishKey = tiers.includes("tinyfish") ? await resolveKey("tinyfish") : undefined;

const NAME_BY_TIER = Object.fromEntries(
  Object.entries(TIER_NUMBERS).map(([name, n]) => [n, name]),
) as Record<number, FetchTierName>;

if (LADDER) {
  // The real thing: hand resilientFetch the whole order and let it escalate.
  const order = tiers;
  console.log(`\n${CASES.length} URLs through the full ladder: ${order.join(" → ")}\n`);
  console.log(`${"page".padEnd(26)}${"answered by".padEnd(13)}${"ok".padEnd(6)}${"chars".padStart(7)}${"ms".padStart(9)}`);

  let correct = 0;
  const unresolved: string[] = [];
  for (const { url, want } of CASES) {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const t0 = Date.now();
    let answeredBy = "–";
    let chars = 0;
    let ok = false;
    try {
      const r = await resilientFetch(url, { order, firecrawlKey, tinyfishKey, maxChars: 20_000 });
      answeredBy = NAME_BY_TIER[r.tier] ?? String(r.tier);
      chars = r.content.length;
      if (/WARNING: no readable content extracted/.test(r.content)) answeredBy += "*";
      ok = want.test(r.content);
    } catch {
      answeredBy = "all failed";
    }
    if (ok) correct++;
    else unresolved.push(host);
    console.log(
      `${host.slice(0, 25).padEnd(26)}${answeredBy.padEnd(13)}${(ok ? "yes" : "NO").padEnd(6)}${String(chars).padStart(7)}${String(Date.now() - t0).padStart(9)}`,
    );
  }
  console.log(`\nladder total: ${correct}/${CASES.length}`);
  if (unresolved.length) console.log(`unresolved: ${unresolved.join(", ")}`);
  console.log("\n* = returned a shell; the ladder fell back to its fullest thin answer");
  await shutdownBrowser();
  process.exit(0);
}

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
      const first = (e as Error).message.split("\n")[0] ?? (e as Error).message;
      notes.push(`${new URL(url).hostname} (${first.slice(0, 48)})`);
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
