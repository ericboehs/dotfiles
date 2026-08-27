# web-providers

Backends for the `web_search` tool in `../web.ts`. One tool, several providers,
one operator-owned order. The model never picks a vendor.

- `config.ts` — persisted settings, chain state, key resolution
- `search.ts` — the backends, the failover chain, and the `/web test` probe

The fetch ladder lives next door in `../web-fetch-resilient/`; the two share a
cool-off table, because Firecrawl bills both from one pool.

## The chain

```
tavily → exa → brave → firecrawl → codex
```

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

## Keys

Resolved from the environment first, then `fnox get <NAME>` (macOS Keychain),
cached per process. Never logged, never written to `web.json`, never shown by
`/web` — status prints presence only.

`BRAVE_API_KEY` · `TAVILY_API_KEY` · `EXA_API_KEY` · `FIRECRAWL_API_KEY`

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
/web fetch  order plain curl chrome safari firecrawl
/web search|fetch off|on <name>
/web format native|serp|answer
/web excerpts auto|short|long
/web test [all] [query]                probe each backend: latency, size, cost
/web reset                             clear cool-offs
```

A partial `order` reprioritises rather than amputates: names you leave out keep
working and move to the back.

`/web test` shares `callBackend()` with the chain, so a probe exercises the real
path rather than something adjacent to it. It does **not** write cool-offs — a
diagnostic tells you the state of the world, it does not change it — and it
probes backends that are off or cooling, since "has it recovered?" is the main
reason to ask. Its first run in a process is cold: TLS setup and Keychain
resolution dominate, so expect the second run to be several times faster.

## Adding a backend

1. Add the name to `SEARCH_BACKENDS` and its env var to `KEY_ENV` in `config.ts`.
2. Write `fooSearch(query, opts, …, key, signal)` returning `BackendResult`, and
   throw `httpError(status, body)` on rejection so it inherits the cool-off
   rules.
3. Add a `case` to `callBackend()` — the chain and the probe both pick it up.
4. Add a row to `COST_PER_CALL`.
