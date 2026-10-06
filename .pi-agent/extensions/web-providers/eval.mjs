// Re-runnable quality eval for the web_search provider chain.
//
//   node web-providers/eval.mjs
//
// Keys come from the environment (BRAVE_AI_API_KEY, TAVILY_API_KEY, EXA_API_KEY).
// Costs one search per backend per mode per query -- currently 60 calls.
//
// This mirrors search.ts rendering rather than importing it, because the chain
// deliberately gives no way to force a single backend: order is operator-owned.
// Keep the three render paths below in sync with search.ts when they change.
//   EXCERPT_CHARS = { short: 200, auto: 1200, long: 2500 }
//   brave  -> description, plus extra_snippets only on long
//   tavily -> raw content, truncated (long is a ceiling change only)
//   exa    -> highlights joined, numSentences 4 (auto) / 8 (long)
// Firecrawl is omitted deliberately: long is a documented no-op there, and its
// search costs 2 credits from the same pool that funds the fetch ladder.

const LIMIT = { short: 200, auto: 1200, long: 2500 };
const clean = (s) => (s ?? "").replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
const truncate = (t, n) => (t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`);
const render = (hits, limit) =>
  hits.map((h) => `- ${h.title}\n  ${h.url}\n  ${truncate(h.excerpt, limit)}`).join("\n");

const CASES = [
  // original six
  { q: "Firecrawl API search endpoint credit cost per request", want: /2 credits/i },
  { q: "Brave Search API free plan monthly request limit", want: /2,?000/ },
  { q: "Tavily advanced search credit cost per request", want: /2 credits?|advanced.{0,40}2/i },
  { q: "Exa answer endpoint price per 1000 requests", want: /\$5\b|5 ?\/ ?1k/i },
  { q: "Node.js experimental strip types parameter property error", want: /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|parameter propert/i },
  { q: "ripgrep flag to exclude a directory from search", want: /--glob|-g ['"]?!|--iglob/ },
  // four harder ones: the fact is real, stable, and usually buried mid-page
  { q: "PostgreSQL default value of max_connections setting", want: /max_connections[\s\S]{0,90}\b100\b|\b100\b[\s\S]{0,50}max_connections/i },
  { q: "SQLite default maximum number of columns per table SQLITE_MAX_COLUMN", want: /\b2000\b/ },
  { q: "git gc.reflogExpire default expiry days unreachable", want: /\b90 days\b|\bninety days\b/i },
  { q: "curl flag to follow redirects short form", want: /-L\b|--location/ },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function brave(q, excerpts) {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", q);
  u.searchParams.set("count", "5");
  u.searchParams.set("country", "us");
  u.searchParams.set("search_lang", "en");
  u.searchParams.set("extra_snippets", "true");
  const r = await fetch(u, { headers: { "X-Subscription-Token": process.env.BRAVE_AI_API_KEY, Accept: "application/json" } });
  if (!r.ok) throw new Error(`brave HTTP ${r.status}`);
  const d = await r.json();
  const useExtra = excerpts === "long";
  return (d.web?.results ?? []).map((x) => {
    const extra = useExtra && Array.isArray(x.extra_snippets) ? x.extra_snippets.map(clean).join(" … ") : "";
    const body = clean(x.description);
    return { title: clean(x.title), url: x.url, excerpt: extra ? `${body} … ${extra}` : body };
  });
}

async function tavily(q) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, search_depth: "basic", max_results: 5, include_answer: false }),
  });
  if (!r.ok) throw new Error(`tavily HTTP ${r.status}`);
  const d = await r.json();
  return (d.results ?? []).map((x) => ({ title: clean(x.title), url: x.url, excerpt: clean(x.content) }));
}

async function exa(q, excerpts) {
  const r = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": process.env.EXA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: q,
      numResults: 5,
      contents: { highlights: { numSentences: excerpts === "long" ? 8 : 4 } },
    }),
  });
  if (!r.ok) throw new Error(`exa HTTP ${r.status}`);
  const d = await r.json();
  return (d.results ?? []).map((x) => ({
    title: clean(x.title),
    url: x.url,
    excerpt: Array.isArray(x.highlights) ? x.highlights.join(" … ").trim() : clean(x.text),
  }));
}

// The deep-tier candidates. Octen returns highlights, so it slots in beside
// tavily and exa; the Agent API writes the answer, so the whole response is
// one hit.
async function octen(q) {
  const r = await fetch("https://api.octen.ai/search", {
    method: "POST",
    headers: { "x-api-key": process.env.OCTEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  if (!r.ok) throw new Error(`octen HTTP ${r.status}`);
  const d = await r.json();
  if (d?.code) throw new Error(`octen ${d.code}: ${String(d?.msg ?? "").slice(0, 80)}`);
  // Single-query returns data.results; the multi-query shape nests under
  // data.search_results[].results. Flatten whichever arrived.
  const raw = Array.isArray(d?.data?.results)
    ? d.data.results
    : (d?.data?.search_results ?? []).flatMap((s) => s?.results ?? []);
  return raw.map((x) => ({ title: clean(x.title), url: x.url, excerpt: clean(x.highlight ?? x.full_content) }));
}

async function perplexity(q) {
  const r = await fetch("https://api.perplexity.ai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ preset: "fast", input: q }),
  });
  if (!r.ok) throw new Error(`perplexity HTTP ${r.status}`);
  const d = await r.json();
  // `output_text` is an SDK convenience; a raw fetch walks output[].content[].
  let answer = typeof d?.output_text === "string" ? d.output_text : "";
  if (!answer.trim() && Array.isArray(d?.output)) {
    answer = d.output
      .filter((o) => o?.type === "message" && Array.isArray(o.content))
      .flatMap((o) => o.content.map((c) => (typeof c?.text === "string" ? c.text : "")))
      .join("\n");
  }
  answer = clean(answer);
  if (!answer) throw new Error("perplexity wrote no answer");
  const cites = (d?.output ?? [])
    .filter((o) => o?.type === "search_results" && Array.isArray(o.results))
    .flatMap((o) => o.results.map((r) => r?.url))
    .filter((u) => typeof u === "string");
  // The Agent API synthesises, so there are no excerpts to hand back — the
  // answer is the result. A citation rides in the url slot so the row traces.
  return [{ title: "answer", url: cites[0] ?? "", excerpt: answer }];
}

// Per-call money: ~$0.004 for the Agent API `fast` preset, metered for Octen.
// Twenty calls per backend across both modes is real spend to re-derive a
// number the cheap three already gave, so the candidates are opt-in — same
// rule as `/web test all`. Run `node eval.mjs --paid` to include them.
const PAID = process.argv.includes("--paid");
const BACKENDS = PAID ? { brave, tavily, exa, octen, perplexity } : { brave, tavily, exa };
const rows = [];
const detail = {};

for (const mode of ["auto", "long"]) {
  for (const [name, fn] of Object.entries(BACKENDS)) {
    let hits = 0, chars = 0, ms = 0;
    const misses = [];
    for (const { q, want } of CASES) {
      await wait(name === "brave" ? 1400 : name === "perplexity" ? 1100 : 200);
      const t0 = Date.now();
      let text = "";
      try {
        text = render(await fn(q, mode), LIMIT[mode]);
      } catch (e) {
        misses.push(`${q} (${e.message})`);
      }
      ms += Date.now() - t0;
      chars += text.length;
      if (want.test(text)) hits++;
      else misses.push(q);
    }
    rows.push({ mode, name, hits, chars: Math.round(chars / CASES.length), ms: Math.round(ms / CASES.length) });
    detail[`${name}/${mode}`] = misses;
  }
}

console.log(`\n${CASES.length} queries, ground-truth string per query`);
console.log(`backends: ${Object.keys(BACKENDS).join(", ")}${PAID ? "  (--paid: this spends real money)" : ""}\n`);
console.log("mode  backend  correct  avg chars  avg ms   correct per 10K chars");
for (const r of rows) {
  const perK = ((r.hits / r.chars) * 10000).toFixed(2);
  console.log(
    `${r.mode.padEnd(5)} ${r.name.padEnd(8)} ${String(r.hits).padStart(4)}/${CASES.length}  ${String(r.chars).padStart(8)}  ${String(r.ms).padStart(6)}   ${perK.padStart(8)}`,
  );
}
console.log("\nmisses:");
for (const [k, v] of Object.entries(detail)) if (v.length) console.log(`  ${k}: ${v.map((s) => s.slice(0, 52)).join(" | ")}`);
