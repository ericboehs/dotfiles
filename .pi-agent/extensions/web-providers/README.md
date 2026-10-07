# web-providers

Backends for the `web_search` tool in `../web.ts`. One tool, several providers,
one operator-owned order. The model never picks a vendor.

- `config.ts` — persisted settings, chain state, key resolution
- `search.ts` — the backends, the failover chain, and the `/web test` probe

The fetch ladder lives next door in `../web-fetch-resilient/`; the two share a
cool-off table, because Firecrawl bills both from one pool. TinyFish is a fetch
tier only — see "Why TinyFish is not in the search chain" below.

## The chain

```
tavily → exa → brave → firecrawl → codex
```

Plus one deep tier that is **not** in this list — see "The deep tier" below.

Failover is **narrow on purpose**. A backend is only abandoned for auth
(401/403, and Brave's 422), quota (402/429/432), 5xx, or a timeout. An empty
result set is an answer, not a failure — otherwise one unlucky query walks the
whole chain and spends four subscriptions to tell you the same nothing.

Brave's one-request-per-second 429 is not exhaustion. That case sleeps 1.1s and
retries the same backend; only a spent monthly counter moves on.

Brave answers **422 for both a revoked token and a malformed query**, so the
body breaks the tie (`SUBSCRIPTION_TOKEN_INVALID`, `component: authentication`).
Guessing "auth" would bench a working backend for a day; guessing "bug" would
re-hit a dead key on every search forever.

Cool-offs: 24h for auth/quota, 10min for 5xx and timeouts, **none** for other
4xx — those are our bug, and surfacing them every call is how they get fixed.
State lives in `skipUntil` and self-heals: expired entries are dropped on read.

### Why this order

Failover fires only on exhaustion, so whatever sits at the head serves nearly
every query. These monthly quotas do not roll over, so there is nothing to save
them for — spend the best one first.

Measured on a three-query bake-off (Aug 2026):

| backend | latency | size | answer in the excerpt? |
|---|---:|---:|---|
| brave | 0.4–0.8s | 1.5–3.0K | rarely — teaser snippets (see "Brave's two plans") |
| tavily | 0.2–2.1s | 5.6–6.2K | usually |
| exa | 0.1–2.1s | 4.9–6.6K | usually |
| firecrawl | 0.8–2.8s | 1.9–5.5K | best — clean tables |
| codex | slowest | ~1.2K | best reasoning |

Brave is the fastest and the largest free pool (2000/mo) but returns teasers,
which cost a follow-up `web_fetch` — and on a pricing query its truncated
snippet quoted *a different model's price*, which a reader could easily take as
the answer. Fuller extracts are both faster end-to-end and harder to misread,
so Brave sits third as high-volume overflow.

Tavily and Exa were then run head to head on six queries with a ground-truth
string each. They tied at **6/6**, with near-identical output size (5971 vs
5784 chars average); Tavily averaged 1036ms to Exa's 1219ms. Total capacity is
order-invariant — 1000 Tavily credits plus ~1430 Exa searches is the same sum
either way — so between two backends of equal quality the tiebreak is latency,
and Tavily keeps the head.

Firecrawl is deliberately behind Brave despite winning on quality: search costs
2 credits out of the same 1000-credit pool that funds the fetch ladder's last
tier, where it is the only thing that can rescue a page nothing else can read.
A credit is worth more there than as a fourth opinion on a SERP.

Caveat: n=3 and n=6, one afternoon. `/web search order …` reverts it.

## The deep tier

`perplexity` (Sonar) is in `SEARCH_BACKENDS` but deliberately **not** in
`search.order`. Nothing reaches it by falling down the chain; only
`hard: true` does, and only the model sets that:

```
hard: true  →  perplexity → tavily → exa → brave → firecrawl → codex
```

It sits outside the order because it is the only backend here with **no free
monthly allowance** — see [No free tier](#no-free-tier) below — and a backend
that can be fallen into is a backend that gets spent on the queries that did
not need it. `/web search off perplexity` disables it; so does a live
cool-off, and both leave the rest of the chain untouched.

`hard` **reorders, it does not add a failure path.** If Perplexity is spent,
benched or off, the chain below it runs exactly as it always has — same
`cooloffForStatus` rules, same 24h/10min benching, same "empty is an answer".
The escalation can never become an exit from the chain.

One exception to the 24h rule, and it is Perplexity's. Its 429 with
`"type": "request_rate_limit_exceeded"` is a requests-per-minute bucket, not
a spent allowance, so it benches for 60s and logs `rate limited`, not `quota
exhausted`. Before this, two `hard` calls sent at once took the deep tier out
for a day with credit still on the account. The match is on that exact type,
not on the words "rate limit": Brave's monthly-quota 429 says "Request rate
limit exceeded" too, and that one is spent until the month rolls over.

### Why this is not the metric the leaderboard ranks on

Artificial Analysis ranks the Search API providers, and Perplexity tops it at
80. That column does not measure a search call. It measures a whole agent
turn, answer model included, and the proof is in the no-search baseline:

| row | Search Index | time per task |
|---|---:|---:|
| Model only (no search at all) | 33 | 21.0s |
| Octen Search (highlights) | 77 | **15.9s** |
| Perplexity Search (medium) | 80 | 27.5s |

Octen posts 77 — four points below the leader — *faster than doing no search
at all*, which is only possible if the number is dominated by the model
generating the answer rather than by the retrieval feeding it. Everything in
this table is priced per benchmark task; a task runs many searches behind a
reasoning model. None of that is comparable to the per-call numbers above,
which is why `/web test` keeps them in separate columns.

The row that actually argued for Sonar was not the index. It was that
`sonar` is the one endpoint on that board that returns a finished answer
rather than links, which is a different product from everything else in the
chain — and the reason it belongs behind a flag rather than at the head.
Tavily and Exa both synthesize too (`include_answer`, `/answer`), and both
measured *worse* for it; see "Synthesis costs accuracy".

### Sonar is gone; the Agent API replaced it

`perplexity` is **not** Sonar any more. Sonar's chat-completions endpoint was
retired on 2026-09-27 and now answers `403` with a migration notice, so this
calls the Agent API:

| | Sonar (retired) | Agent API |
|---|---|---|
| endpoint | `/v1/chat/completions` | `/v1/responses` (alias of `/v1/agent`) |
| prompt | `messages` | `input` |
| model | `model: "sonar"` | `preset: "fast"` |
| answer | `choices[0].message.content` | `output[].content[].text` |
| sources | `citations[]` | `output[]` item of `type: "search_results"` |
| recency | `search_recency_filter` | same key, under the tool's `filters` |

Two traps worth writing down. `output_text` is an **SDK** convenience
property — a raw `fetch` does not get it for free, so `agentText()` falls
back to walking `output[]`. And `preset: "fast"` enables web search on its
own, so the plain request needs no `tools` block at all; only a recency
filter adds one.

### The price changed too

`COST_PER_CALL` says ~$0.004, computed from Perplexity's published rates:
1000 input tokens × $0.20/1M, 500 output × $1.20/1M, one `web_search`
invocation × $0.0025. That is *below* Exa's $0.007 list price, not the order
of magnitude above it this section originally claimed — which is exactly why
list price is the wrong comparison. See the next section.

The old figure came from the leaderboard's "$62.30 per 1k tasks" column, which
is a different unit again — a benchmark task is many searches behind a
reasoning model. It was never a per-call price, and reading it as one is the
single easiest way to mis-plan this tier. Treat the leaderboard as a quality
ceiling, never as a price list.

### No free tier

Perplexity's API has **no complimentary credits on any plan** — the help
center says so for the API Platform, and a Pro subscription no longer carries
the $5/month of API credit that older guides still cite. Every call bills
from the first one. The other backends do not:

| backend | free each month | ≈ searches | checked |
|---|---|---|---|
| tavily | 1,000 credits | 1,000 | docs |
| exa | $10 of credit | ~1,400 at $0.007 | `costDollars` on a live call |
| brave | 2,000 requests | 2,000 | `x-ratelimit-limit` on a live call |
| **perplexity** | **none** | 0 | help center |

So the chain answers roughly 4,400 searches a month before anything bills,
and the cheap-looking comparison inverts once the allowance is counted. Put
perplexity second and every Tavily failure that Exa would have answered for
free costs $0.004 instead. That, not its list price, is what keeps it behind
`hard`.

Two things moved this table on 2026-10-07 and are worth not re-learning.
Exa's highlights are **not** billed as page contents: `costDollars` came back
`0.007`, all of it `search`. And Brave's 2,000 is a **legacy** free plan —
Brave now offers new accounts $5/month of credit, about 1,000 searches — so a
re-created `BRAVE_AI_API_KEY` would quietly halve the largest pool here.

### What it costs when the model asks for it

Sonar answers in one round trip. Measured against Tavily's ~1.0s, expect
roughly 3–10s. The excerpt params do not apply to it — there are no excerpts
to truncate. Under `links_only` the citations become the hits and the essay
is dropped, so the flag still means something on this backend.

`eval.mjs --paid` scores it against the same ten ground-truth queries as
everything else. Without the flag it does not run: twenty calls is real spend
to re-derive what the free three already answer.

### Why TinyFish is not in the search chain

TinyFish Search is free at any wallet balance, which makes it look like an
obvious addition. Measured head-to-head over 5 queries at `excerpts=auto`, it
is dominated by a backend already in the chain:

| backend | mean ms | chars/result |
|---|---|---|
| brave | **633** (583–661) | 262 |
| tinyfish | 979 cold | **134** |
| exa | 1598 | 3880 |
| tavily | 1615 | 1192 |

Those are raw API values, before `render()` truncates each hit to
`EXCERPT_CHARS`. At `auto` (1200) the cap binds on Exa and roughly meets
Tavily, so the two converge to ~1200 in the output that actually reaches the
model — which is why `eval.mjs` scores them at 5386 and 5843 average chars.
Brave and TinyFish are unaffected because they never reach the cap.

That is the whole point: 134 is a **ceiling, not a cap**. Every other backend
will give you more text if you ask for it; TinyFish has no more to give at any
excerpt setting.

Brave is faster *and* returns roughly twice the excerpt, so TinyFish could only
ever sit behind it — and since failover fires only on exhaustion, a slot behind
Brave's 2000/month is a slot that never serves a query.

The 134 chars/result is disqualifying on its own. It is below the `short`
budget (200), so `EXCERPT_CHARS` never binds and `excerpts: long` is a no-op:
there is no depth to truncate. That is the same teaser failure that demoted
Brave, one step worse. On the GLM-5.3-Flash pricing query TinyFish returned
`$0.045 per task` and `$17.50/1M` (a *video* rate) alongside the real token
prices — all correctly attributed to the right model, all unlabelled at 134
characters. The failure mode is not wrong-model, it is right-model/wrong-unit,
and a teaser is exactly the wrong length to catch it.

Watch the latency claim too: repeat queries return byte-identical payloads in
110–200ms, so the sub-second figures in TinyFish's marketing are cache hits.
Cold, novel queries average ~1s despite an advertised P50 of 488ms.

Its Fetch endpoint is a different story, and that is where it landed — as the
strongest single tier in the fetch ladder, 11/13 on the hostile-page eval. Free
and thin is a bad trade for a snippet and a good one for a full page render.

Caveat: n=5, one afternoon, from one location.

## Output shape

Two axes, both set with `/web`, plus a per-call override.

**`format`** — `native` (default), `serp`, `answer`.
`native` renders whatever the backend is good at. `serp` forces a compact link
list. `answer` demands prose, and any backend that cannot synthesize passes to
the next one *without* a cool-off — it declined this request, it is not broken.

In `answer` mode the chain effectively becomes **tavily → exa → codex**; Brave
and Firecrawl always pass.

Exa serves `answer` from its separate `/answer` endpoint, which is the rare case
of synthesis being the *cheap* option: **$5/1k against `/search`'s $7/1k**, and
336–626 characters instead of 10–17KB of raw results. It returns in 1.2–1.5s —
occasionally faster than the plain search it replaces — so it is nothing like
the nested-agent latency of Codex.

### Synthesis costs accuracy

On six queries with a ground-truth string each, the same backends scored **6/6
in `native`** and worse in `answer`:

| | correct | avg latency | avg size |
|---|---|---:|---:|
| tavily `include_answer` | 4/6 | 704ms | 476 chars |
| exa `/answer` | 5/6 — effectively 6/6 | 1537ms | 916 chars |

Both Tavily misses were real, and one was the interesting kind: asked the price
of Exa's **`/answer`** endpoint it answered for **`/search`**, then invented a
20,000-request free tier. Exa's one "miss" was the benchmark's fault — it
correctly described Brave's current public pricing while the expected string
came from this account's plan-specific rate-limit header.

So `answer` trades accuracy for ~10x fewer tokens. That is why `native` is the
default and `answer` is opt-in.

### The subject line

Exa's answers are requested with an `outputSchema` carrying a `subject` field,
and the rendered answer ends with:

```
(Exa answered about: GLM-5.3)
```

Asked about GLM-5.3 **Flash**, the endpoint answers about GLM-5.3 and buries
the swap in fluent prose. Naming the subject makes that visible at a glance.
Costs nothing extra ($0.005 either way) and adds ~200ms.

It is **reported, never judged**. "GLM-5.3" is a substring of the query that
asked for "GLM-5.3 Flash", so any automatic check would wave the mismatch
through — the reader is better at this than a string comparison.

`/answer` also takes no date filter, so it **declines** when `recency` is set
rather than quietly answering a different question, and the call passes to a
backend that can honour it.

**`excerpts`** — `short` (~200 chars), `auto` (~1200), `long` (~2500).

This one is not uniform, because "more text" is a different product per vendor:

| backend | what `long` actually does |
|---|---|
| tavily | nothing at the API; only raises the truncation ceiling (measured +436 chars) |
| exa | asks for 8 highlight sentences instead of 4 (measured 6.0K → 8.1K) |
| brave | `extra_snippets`, on the "Data for AI" plan only (206 → ~1450 chars/result) |
| firecrawl | nothing; it returns full extracts regardless |

Brave silently dropping `extra_snippets` is not a failover reason. Treating it
as one would push every long-excerpt query onto Tavily and drain it.

### Brave's two plans

Brave sells "Data for Search" and "Data for AI" as separate subscriptions with
separate keys and separate 2000/month quotas. Only the AI plan includes
`extra_snippets`, so `BRAVE_AI_API_KEY` is preferred over `BRAVE_API_KEY` when
both are present, and `/web` names the variable that won.

The AI plan returns `extra_snippets` **whether or not the parameter is set**,
and the search plan omits them even when it is — so the decision that matters
is ours, not the API's: the extras are rendered on `long` and dropped
otherwise. Measured on the six ground-truth queries, including them scored
**5/6 either way** while tripling the payload (1826 → 5900 chars). Much of the
addition is boilerplate.

On the pricing canary the extras are genuinely double-edged: they recovered the
correct list price that truncation had cut off, and simultaneously surfaced a
competing model's price that truncation had been hiding. More complete and
more contaminated in the same breath. Worth it when depth was asked for,
wasteful when it wasn't.

Still gated even on "Free AI": the summarizer (`summary=1` returns null) and
`/res/v1/llm/context` (`OPTION_NOT_IN_PLAN`).

The tool also takes a per-call `excerpts` parameter, for when the model is
chasing a specific number and wants the surrounding context. It overrides
length only — never the backend — and does not touch the saved config.

### `long` does not buy accuracy

Ten ground-truth queries, every backend, both modes (`web-providers/eval.mjs`):

| mode | backend | correct | avg chars | correct per 10K chars |
|---|---|---:|---:|---:|
| auto | brave | 9/10 | 1850 | **48.7** |
| auto | tavily | **10/10** | 5843 | 17.1 |
| auto | exa | 9/10 | 5386 | 16.7 |
| long | brave | 9/10 | 8038 | 11.2 |
| long | tavily | 10/10 | 6256 | 16.0 |
| long | exa | 9/10 | 7578 | 11.9 |

Not one backend scored better on `long`, and **the misses were identical in
both modes** — ripgrep for Brave, `max_connections` for Exa. Those are
retrieval failures, not truncation failures: the answer was never on the pages
that came back, and widening the window cannot add what was not retrieved.

So `long` is for reading more of a page already known to be right, not for
finding a page that `auto` missed. It is not a retry strategy.

Brave on `auto` is three times more token-efficient than anything else here,
which reads like an argument for promoting it. It is weaker than it looks: this
eval asks whether the ground-truth string appears, and Brave's known failure
mode is that the right string appears *next to the wrong subject* — the
GLM-5.3 canary passes this check while being genuinely misleading. The eval
cannot see the failure Brave is most prone to, so it does not get to settle the
order.

Latency was not comparable across modes here: the second pass reuses the first
pass's queries and Brave and Tavily both served them from cache (544ms → 190ms,
1244ms → 71ms). Efficiency numbers are per-character, so they are unaffected.

## What this costs before you ask it anything

Measured, because both numbers are paid on every session whether or not a
search happens.

**Context.** The `web_search` name, description and schema total ~650
characters, roughly 180 tokens, up ~63 from the single-backend version. Those
sit in the cached prompt prefix, so the marginal per-turn cost is a fraction of
that. The `excerpts` parameter is declared with `enum` rather than a union of
literals: TypeBox expands a union into three `anyOf` branches, which cost ~150
characters of schema per request to express the same three words.

**Boot.** `config.ts` and `search.ts` add **~3ms** to extension load. The
extension's ~375ms is almost entirely `fetch-core.ts` (~265ms of jsdom,
Readability and Turndown) and predates the provider chain. Nothing here does
I/O at import: config is read on first use, keys are resolved only when a
backend is actually reached, and a fetch that never escalates never touches the
Keychain.

### What was actually searched

Brave silently spellchecks and rewrites queries. It reports this in
`query.altered`, and only populates that field when it really did change
something, so the rendered output leads with a line **only when the terms
differed**:

```
(searched as: how do i exclude a directory from ripgrep search)

- [Ignore a Folder in Ripgrep](https://blog.wxm.be/...)
```

An unconditional echo of the query would be noise — the caller already knows
what it asked. The signal is the *divergence*, so that is the only thing
reported. It also appears as `details.searchedAs` when present, and is absent
entirely otherwise.

Tavily echoes the query verbatim and Exa returns no autoprompt string, so
neither has anything to report; this is a Brave-only annotation today.

### Who answered

Every result ends with a footer naming the backend that produced it, the way
`web_fetch` names its tier:

```
---
[via brave · 1,929 of 2,000 left this month]
```

The text alone does not say whether it is ranked excerpts or a provider's
written prose, and the two deserve different trust — so the footer says. It
names the backend that *answered*, which after a failover is not the first one
in the order. It is a report, not a choice: no parameter accepts a vendor, so
the operator-owns-order invariant holds. Brave adds its monthly quota from
`x-ratelimit-remaining`/`-limit`, the only backend that reports one on
success; `/web test` shows the same live count in its cost column.

## Keys

Resolved from the environment first, then `fnox get <NAME>` (macOS Keychain),
cached per process. Never logged, never written to `web.json`, never shown by
`/web` — status prints presence only.

`BRAVE_API_KEY` · `TAVILY_API_KEY` · `EXA_API_KEY` · `FIRECRAWL_API_KEY` ·
`PERPLEXITY_API_KEY` (deep tier; `PERPLEXITY_SEARCH_API_KEY` also accepted) ·
`TINY_FISH_API_KEY` (fetch tier; `TINYFISH_API_KEY` also accepted, since that is
the name TinyFish's own docs use)

A backend with no key is skipped silently rather than failing: an unconfigured
provider is a chain that is shorter than you thought, not an error.

Codex uses pi's own credentials via `/login`, so it needs the live model
registry — which is why `/web test` skips it unless you ask for `test all`.

## Config

`<agent-dir>/web.json`, mode 0600, written atomically via rename. A malformed
file degrades to defaults rather than taking web access down mid-session;
unknown names are dropped on read.

```
/web                                   chains, key presence, cool-offs
/web search order tavily exa brave firecrawl codex
/web fetch  order plain curl chrome tinyfish firecrawl safari
/web search|fetch off|on <name>            # off perplexity kills the deep tier
/web format native|serp|answer
/web excerpts auto|short|long
/web test [all] [query]                probe each backend: latency, size, cost
/web reset                             clear cool-offs
```

`perplexity` is not part of `/web search order` by default. Adding it there is
allowed and is your call — it just makes it reachable by exhaustion too, which
costs ~$0.004 a hit.

A partial `order` reprioritises rather than amputates: names you leave out keep
working and move to the back.

`/web test` shares `callBackend()` with the chain, so a probe exercises the real
path rather than something adjacent to it. It does **not** write cool-offs — a
diagnostic tells you the state of the world, it does not change it — and it
probes backends that are off or cooling, since "has it recovered?" is the main
reason to ask. Its first run in a process is cold: TLS setup and Keychain
resolution dominate, so expect the second run to be several times faster.

Codex and Perplexity are skipped unless you ask for `/web test all`, for the
same reason Firecrawl and Safari are skipped below: one needs the live model
registry and the other bills ~$0.004 a call. A diagnostic you hesitate to run
is one you stop running.

The table carries an `index` column from `SEARCH_INDEX` — the Artificial
Analysis Search Index, where a provider publishes one. It is a dash for
tavily, exa, brave and firecrawl, and that dash is the honest answer rather
than a missing one: the index ranks providers whose product *writes the
answer*, and scores a whole agent turn with a reasoning model attached. Its
number and this table's `ms` column are not the same measurement. Do not
sort by it. See "Why this is not the metric the leaderboard ranks on".

It prints a second table for the fetch ladder, probing each tier once against
`example.com` via `probeFetchTiers()` — same no-cool-off rule, same real code
path (a one-name `order`). Firecrawl and Safari are skipped unless you ask for
`/web test all`, because one bills a credit and the other opens a window, and a
diagnostic you hesitate to run is one you stop running. That is a liveness
check; scored quality across hostile pages lives in
`../web-fetch-resilient/eval.ts`.

## Adding a backend

1. Add the name to `SEARCH_BACKENDS` and its env var to `KEY_ENV` in `config.ts`.
2. Write `fooSearch(query, opts, …, key, signal)` returning `BackendResult`, and
   throw `httpError(status, body)` on rejection so it inherits the cool-off
   rules.
3. Add a `case` to `callBackend()` — the chain and the probe both pick it up.
4. Add a row to `COST_PER_CALL`.
5. Add it to `DEFAULT_CONFIG.search.order` — **unless** it is a deep tier. A
   backend that only `hard` should reach stays out of the order (see
   "The deep tier"), and is gated in `deepTier()` instead.
