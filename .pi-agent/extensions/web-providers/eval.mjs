// Re-runnable quality eval for the web_search provider chain.
//
//   node web-providers/eval.mjs          # brave, tavily, exa
//   node web-providers/eval.mjs --paid   # adds octen and perplexity
//
// Keys come from the environment: BRAVE_AI_API_KEY, TAVILY_API_KEY, EXA_API_KEY,
// plus OCTEN_API_KEY and PERPLEXITY_API_KEY for --paid. The run prints the API
// calls it made: at 20 queries, 100 by default and 140 with --paid (see
// MODE_BLIND for why it is not five backends x two modes x 20).
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
  // Brave replaced its free plan with $5 of monthly credit. The old answer,
  // 2,000 requests, still fills stale pages: every link backend "passed" by
  // quoting one, and the only backend that failed this case was the one that
  // was right. `(?! card)` because "$5 ... no credit card" is pricing copy.
  { q: "Brave Search API free plan monthly request limit", want: /\$5(?:\.00)? (?:in |of )?(?:free )?(?:monthly )?credits?\b(?! card)/i },
  { q: "Tavily advanced search credit cost per request", want: /2 credits?|advanced.{0,40}2/i },
  { q: "Exa answer endpoint price per 1000 requests", want: /\$5\b|5 ?\/ ?1k/i },
  { q: "Node.js experimental strip types parameter property error", want: /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|parameter propert/i },
  { q: "ripgrep flag to exclude a directory from search", want: /--glob|-g ['"]?!|--iglob/ },
  // four harder ones: the fact is real, stable, and usually buried mid-page
  { q: "PostgreSQL default value of max_connections setting", want: /max_connections[\s\S]{0,90}\b100\b|\b100\b[\s\S]{0,50}max_connections/i },
  { q: "SQLite default maximum number of columns per table SQLITE_MAX_COLUMN", want: /column[\s\S]{0,60}\b2,?000\b|\b2,?000\b[\s\S]{0,30}column/i },
  { q: "git gc.reflogExpire default expiry days unreachable", want: /\b90 days\b|\bninety days\b/i },
  { q: "curl flag to follow redirects short form", want: /-L\b|--location/ },
  // Ten more, added when every link backend scored 10/10 on the ten above and
  // the eval stopped telling them apart. Two shapes those lacked: defaults that
  // live only in a reference page's table, and "which version introduced X",
  // where the snippet that ranks is often about the experimental release or a
  // neighbouring limit (a job's 6 hours, not a run's 35 days). Bare numbers
  // are anchored to their setting: "120" or "10,000" alone is on any page.
  { q: "nginx large_client_header_buffers default value", want: /\b4 8k\b/i },
  { q: "Kafka log.retention.hours default", want: /\b168\b/ },
  { q: "Elasticsearch index.max_result_window default", want: /result[_ ]window[\s\S]{0,120}\b10,?000\b|\b10,?000\b[\s\S]{0,60}result[_ ]window/i },
  { q: "PostgreSQL maximum identifier length NAMEDATALEN", want: /\b63\b[\s\S]{0,40}(bytes|characters|chars)/i },
  { q: "OpenSSH sshd LoginGraceTime default", want: /LoginGraceTime[\s\S]{0,200}\b120\b|\b120 ?(?:s|sec|seconds)\b/i },
  { q: "RFC 5321 maximum length of email address local part", want: /\b64\b[\s\S]{0,30}(octets|characters|chars|bytes)/i },
  { q: "GitHub Actions maximum workflow run time limit", want: /\b35 days\b/i },
  { q: "Node.js version where the fetch API became stable", want: /\b(?:node(?:\.js)?\s*v?|v)21\b/i },
  // "5.1" is anchored to kernel/release words on either side: Exa's correct
  // answer read "showed up in the 5.1 release" and "added to the 5.1 kernel",
  // which a prefix-only anchor rejected. \b already refuses 5.10 and 5.14.
  { q: "Linux kernel version that first merged io_uring", want: /(?:linux|kernel|version|release)[\s\S]{0,20}\b5\.1\b|\b5\.1\b[\s\S]{0,20}(?:kernel|release)/i },
  { q: "Git version that introduced git switch and git restore", want: /\b2\.23\b/ },
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

// Per-call money: ~$0.0012 for the Agent API `fast` preset (measured; no free
// tier), metered for Octen.
// Twenty calls per backend across both modes is real spend to re-derive a
// number the cheap three already gave, so the candidates are opt-in — same
// rule as `/web test all`. Run `node eval.mjs --paid` to include them.
const PAID = process.argv.includes("--paid");
const ALL = PAID ? { brave, tavily, exa, octen, perplexity } : { brave, tavily, exa };

// Narrowing, so checking a handful of misses costs a handful of calls:
//   --only <regex>      queries to run, matched case-insensitively against q
//   --backends a,b      backends to run, from the set --paid allows
//   --dump              print the full rendered text of every miss, so a real
//                       miss can be told apart from a check that is too strict
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const DUMP = process.argv.includes("--dump");
const ONLY = flag("--only") && new RegExp(flag("--only"), "i");
const PICK = flag("--backends")?.split(",").map((s) => s.trim());
const unknown = (PICK ?? []).filter((n) => !(n in ALL));
if (unknown.length) {
  console.error(`unknown or unpaid backend: ${unknown.join(", ")}${PAID ? "" : " (octen and perplexity need --paid)"}`);
  process.exit(2);
}
const BACKENDS = PICK ? Object.fromEntries(PICK.map((n) => [n, ALL[n]])) : ALL;
const cases = ONLY ? CASES.filter((c) => ONLY.test(c.q)) : CASES;
if (!cases.length) {
  console.error(`--only matched no queries`);
  process.exit(2);
}

// Backends whose request ignores the excerpt mode: the API call is identical in
// auto and long, and only the render truncation differs. Each is called once
// per query and that one response is rendered at both limits, so the long row
// costs nothing and its ms column times the same call. brave and exa change
// the request itself (extra_snippets, numSentences), so they really run twice.
const MODE_BLIND = new Set(["tavily", "octen", "perplexity"]);
// Perplexity answers a burst with 429 request_rate_limit_exceeded (see
// cooloffForStatus), and an error here scores as a miss. Space it out.
const PACE_MS = { brave: 1400, perplexity: 2500 };
const responses = new Map();
let calls = 0;

async function ask(name, fn, q, mode) {
  const key = `${name}\0${q}`;
  if (MODE_BLIND.has(name) && responses.has(key)) return responses.get(key);
  await wait(PACE_MS[name] ?? 200);
  calls++;
  const t0 = Date.now();
  let res;
  try {
    res = { hits: await fn(q, mode) };
  } catch (e) {
    res = { error: String(e?.message ?? e).slice(0, 80) };
  }
  res.ms = Date.now() - t0;
  if (MODE_BLIND.has(name)) responses.set(key, res);
  return res;
}

const short = (q) => (q.length > 52 ? `${q.slice(0, 51)}…` : q);
const rows = [];
const detail = {};
const dumps = [];

for (const mode of ["auto", "long"]) {
  for (const [name, fn] of Object.entries(BACKENDS)) {
    let hits = 0, chars = 0, ms = 0;
    const misses = [];
    for (const { q, want } of cases) {
      const res = await ask(name, fn, q, mode);
      const text = res.hits ? render(res.hits, LIMIT[mode]) : "";
      ms += res.ms;
      chars += text.length;
      // An error is one miss with its reason, not a bare query that reads like
      // a wrong answer (and is not counted twice).
      if (res.error) misses.push(`${short(q)} (${res.error})`);
      else if (want.test(text)) hits++;
      else {
        misses.push(short(q));
        if (DUMP) dumps.push({ key: `${name}/${mode}`, q, want, text });
      }
    }
    rows.push({ mode, name, hits, chars: Math.round(chars / cases.length), ms: Math.round(ms / cases.length) });
    detail[`${name}/${mode}`] = misses;
  }
}

console.log(`\n${cases.length} queries, ground-truth string per query, ${calls} API calls`);
console.log(`backends: ${Object.keys(BACKENDS).join(", ")}${PAID ? "  (--paid: this spends real money)" : ""}\n`);
console.log("mode  backend    correct  avg chars  avg ms   correct per 10K chars");
for (const r of rows) {
  const perK = ((r.hits / r.chars) * 10000).toFixed(2);
  console.log(
    `${r.mode.padEnd(5)} ${r.name.padEnd(10)} ${String(r.hits).padStart(4)}/${cases.length}  ${String(r.chars).padStart(8)}  ${String(r.ms).padStart(6)}   ${perK.padStart(8)}`,
  );
}
console.log("\nmisses:");
for (const [k, v] of Object.entries(detail)) if (v.length) console.log(`  ${k}: ${v.join(" | ")}`);
for (const d of dumps) {
  console.log(`\n${"=".repeat(78)}\n${d.key}  ${d.q}\nwant: ${d.want}\n${"-".repeat(78)}\n${d.text || "(empty)"}`);
}
