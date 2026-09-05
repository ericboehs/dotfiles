# web_fetch (resilient) — fetch core

This directory holds the **tiered fetch core** used by `../web.ts`, which owns the `web_fetch` tool registration (single registrar — registering `web_fetch` here as well causes a tool-conflict startup error).

## Tiers

Default order: `plain → curl → chrome → tinyfish → firecrawl → safari` (`obscura` slot reserved between `curl` and `chrome`, off by default since v0.2.1 measured 0/16 ladder answers — see `eval.ts` and `config.ts`).
Tier *numbers* are stable identities, not positions — reordering the ladder
never renumbers a tier, so a `[via tier 6]` footer means the same thing across
any ordering.

| Tier | Client | Defeats |
|---|---|---|
| 1 | plain `fetch` | nothing — the control; handles most sites |
| 2 | `curl` with a coherent browser header set (UA from the installed Chrome binary + matching `sec-ch-ua`, sec-fetch-*, brotli) | header-coherence edge blocks |
| 3 | directly launched, persistent headless Chrome + CDP attach | JS-sensor bot detection (Akamai, etc.) — executes the sensor and passes like an ordinary browser |
| 4 | dedicated minimized private Safari window (macOS) | an independent real-browser trust tier when Chrome's profile is denied/rate-limited |
| 5 | Firecrawl scrape | a hosted renderer with its own egress IPs — costs a credit per page |
| 6 | TinyFish fetch | a hosted Chromium render returning markdown — free at any wallet balance |
| 7 | Obscura `fetch --dump html` (off by default) | stateless local V8 render — instant boot, no profile trust |

### Why the rescue tiers sit in that order

Tiers 5 and 6 do the same job: render a page from someone else's
infrastructure when everything local has been denied. TinyFish goes first
because it is free, because Firecrawl's credits come from the same
1000-credit pool the search chain draws on, and — measured — because it is the
more capable of the two.

Thirteen URLs, ground-truth string per page, each tier forced in isolation
(`eval.ts`):

| tier | correct | shell | fail | avg chars | avg ms |
|---|---:|---:|---:|---:|---:|
| plain | 6/13 | 1 | 5 | 3738 | 339 |
| curl | 6/13 | 1 | 6 | 3531 | 288 |
| chrome | 8/13 | 0 | 2 | 6893 | 14304 |
| **tinyfish** | **11/13** | 0 | 2 | 5352 | 1262 |
| firecrawl | 8/13 | 0 | 4 | 10004 | 417 |

The headline is not that TinyFish scores highest. It is that **Chrome and
TinyFish fail on disjoint pages**.

TinyFish misses exactly two: `g2.com` and `glassdoor.com`, which reject
datacenter IPs outright — G2 with a 403, Glassdoor with a flat `bot_blocked`.
Chrome fetches both without complaint, because it is coming from a residential
connection with a real sensor result. Chrome in turn misses Reddit,
StackOverflow, Bloomberg, Zillow and Indeed, all of which TinyFish renders.

An earlier draft of this file concluded from that table that `chrome →
tinyfish` therefore clears all thirteen. **It does not, and the reason is worth
more than the claim was.** Isolated scores are an *oracle*: they say what the
best tier per page would return if something asked it. The ladder only escalates
when a tier *throws*, so a tier that returns a plausible-looking wall ends the
chain above the tier that would have worked. Measured end to end with
`--ladder`, the union that the table predicts at 15/16 actually delivered 12/16
until `thin()` was tightened. Always measure the chain, not the parts.

That is the argument for keeping a hosted renderer *behind* a local browser
rather than in front of it: they are not redundant, they fail differently, and
the cheap local one should get first refusal. It is also the argument for
TinyFish over Firecrawl in the rescue slot — Firecrawl manages 8/13 while
billing a credit per page, and loses Reddit, G2, Glassdoor and Bloomberg.
Firecrawl keeps the tier behind because when it does work it returns the most
text of anything in the ladder (10K average).

Chrome's 14.3s average is not a typo. Hostile pages are where it spends its
time, and much of that is retry and sensor work on pages it ultimately fails.
On the easy half of the set it is comfortably sub-second.

Firecrawl still earns its slot: it returns roughly twice the characters when it
works, so it stays as the tier behind.

Safari is last *despite* being free and local. It drives the real GUI
application, so it is the one tier the user can see running; that makes it a
genuine last resort rather than a mid-ladder default. The 429 rule below still
holds — it just now applies at the end of the ladder instead of the middle.

Two integration details that are easy to get wrong, both found by the eval:

- **TinyFish returns the page title as a separate field and omits it from
  `text`.** The HTML tiers get a `# Title` line for free from Readability and
  Firecrawl's markdown carries its own, so a passthrough loses it and the
  result reads as a worse extraction than it is. Tier 6 restores it. `thin()`
  strips that line before judging content, so this cannot disguise a shell.
- **TinyFish reports per-URL outcomes in an `errors[]` array** rather than
  failing the request, so a dead link arrives as HTTP 200 with empty `results`.
  Tier 6 unwraps the inner status before throwing, which is what lets a 404
  stay in rotation while a 401 earns a cool-off. Its rate limit is **per
  minute** (150 URLs free), not per month, so `web.ts` overrides the shared
  cool-off table for a TinyFish 429 and benches it for 60s instead of the usual
  24h — giving up the only free rescue tier for a day over a momentary burst is
  the expensive mistake.

Caveat: n=13, one afternoon, one location, single run. Bot scoring is not a
pure function of the request — Chrome has thrown on pages it fetched minutes
earlier — so re-run `eval.ts` before concluding a tier regressed. This table
also predates two corrections below, and over-counts slightly: it was scored
when the Tractor Supply marker still matched the page title, which every tier
can read off a bot wall.

### What the ladder actually returns

`eval.ts --ladder` runs the configured order end to end and reports which tier
answered. Sixteen URLs, same markers:

| | isolated oracle | ladder, before | ladder, after |
|---|---:|---:|---:|
| correct | 15/16 | 12/16 | **13/16** |

The gap between the first two columns was entirely `thin()`. Reddit came back
from Chrome as 321 characters of "Sign in with Apple / Continue with Email",
Indeed as 296 of "Create an account or sign in" — both over the flat
200-character floor, so both were accepted as the page. Tractor Supply was
worse: 599 characters of pure navigation that *passed the eval* on its title.

So the floor now scales with the size of the document that produced it
(`rawBytes / 300`, clamped to 200–1000) and registration walls are matched
outright. Reddit now resolves at TinyFish with 5,679 characters, Indeed at
TinyFish with 2,565, Tractor Supply at Chrome with 10,418.

Escalating more eagerly costs latency, and it is worth knowing how much: the
full suite went **176.3s → 172.7s**, i.e. nothing outside noise. No easy page
regressed — all five still answer at tier 1. Tractor Supply individually pays
11.5s to climb to Chrome, which is the honest price of not returning a navbar.

Three remain unresolved, and only one is a ladder failure. Instagram is a
deliberate ceiling: every tier renders the profile header, none reach the
posts. Zillow returns 2,755 characters of accessibility boilerplate, which is
too much prose to call thin without endangering genuinely terse pages.
Bloomberg flipped from pass to fail between two runs of the same code, which is
the stochasticity caveat above, in the wild.

## Evals and probes

```sh
node --experimental-strip-types eval.ts                      # free headless tiers, in isolation
node --experimental-strip-types eval.ts --all                # + firecrawl (credits) + safari (GUI)
node --experimental-strip-types eval.ts --tiers chrome,tinyfish
node --experimental-strip-types eval.ts --ladder             # the real chain, escalating
```

Two modes, answering different questions. The default forces one tier at a time
and scores each in isolation. `--ladder` reads the persisted config and runs the
shipped order end to end, reporting which tier actually answered. Run both:
isolated scores are an upper bound the chain does not automatically reach, and
the 12/16-vs-15/16 gap above is what that looks like when it goes wrong.

`eval.ts` scores **after extraction and truncation**, because that is the only
boundary that matters: a raw API payload flatters whichever backend sends the
most bytes, and bytes that do not survive extraction are bytes the model never
sees. Forcing a tier with a one-name `order` runs the real ladder code rather
than a copy of it.

Ground-truth strings have to clear two bars — stable enough that a miss means
retrieval failed rather than the fact moved, and present inside the 20K
truncation window, or the eval measures the budget instead of the tier.
Reddit is checked for a `u/handle`, Glassdoor for a `media.glassdoor.com` asset
URL, Hacker News for a post score, and Tractor Supply for a category name, all
for a related reason: every tier can scrape a title out of a bot wall, so a
marker the failing tiers can satisfy would score the wall as a success. Tractor
Supply proved that the hard way — it was scored green for four runs on a title
match while returning nothing but a navbar.

Every URL is confirmed live and every marker confirmed reachable by at least
one tier, except Instagram, which is deliberately a ceiling. That check is not
ceremony: an earlier draft used a dead ASIN whose 404 page reads "Continue
shopping", which looks exactly like a bot wall and was very nearly recorded as
one. Amazon fetches fine with a live URL.

The 16 cases run from `example.com` up through Akamai, Cloudflare, PerimeterX,
registration walls and outright datacenter-IP bans, so the table separates
tiers instead of flattering all of them. Six easy pages would have every tier
at 5/6.

For a liveness check rather than a quality one, `/web test` probes each tier
once against `example.com` and prints latency, size, and cost beside the search
chain. It skips Firecrawl and Safari unless you ask for `/web test all`, since
one bills a credit and the other steals focus.

`web_fetch` behavior (in `web.ts`):
- **YouTube**: `yt-dlp` first (timestamps + metadata); falls back to the player-intercept transcript below.
- **Everything else**: the tier ladder.
- PDFs: detected by content-type / `%PDF-` magic and run through `pdftotext`.

## Design notes (from Tractor Supply CLI — Akamai Sensor Research)

- **Honest reduced UA**: major version comes from the installed binary (`--version`), then uses Chrome's normal reduced form (`151.0.0.0`, not the full patch version). Set at launch so client hints follow — a CDP-level override leaves them contradicting the header.
- **One warm profile/process**: trust is scoped to `~/.pi/agent/web-fetch-direct-profile`. Chrome intentionally outlives pi and `/reload`; the saved debugger port lets the next extension instance reattach.
- **No automation launcher**: Chrome is spawned directly with the Tractor CLI's minimum flags. Playwright only attaches afterward over CDP. A fixed nonzero port is essential—`--remote-debugging-port=0` itself sets `navigator.webdriver=true`.
- **Same-origin fallback**: after a denied navigation, warm the origin and execute `fetch()` inside that tab. Chrome supplies HttpOnly cookies, TLS/H2 fingerprint, and reserved headers coherently; TSC waits for `_abck` validation before spending the request.
- **Explicit deny detection**: challenge markers (`edgesuite`, `cf-chl`, Incapsula, Amazon's `continue shopping` wall…) on a 200 are reported as denials, never as successful empty fetches.
- **Success is judged after extraction, not before**: a tier only counts if the *answer* is substantive. A JS application shell is a well-formed 200 that Readability reduces to a title and nothing else — Reddit returned `200 · complete` with an empty body until this existed. Size is half the judgement: example.com is 1.2KB of HTML and 167 characters of prose, and that is the whole page, so only documents ≥ 8KB are suspicious for yielding < 200 characters. Compact SPA shells are the exception: a Next.js empty export (`<div id="__next"></div>` + `__NEXT_DATA__`) is ~2KB and never reaches that floor, so those are recognised by shape, not size. If every tier extracts nothing, the fullest attempt is returned with an explicit `WARNING` rather than thrown away.
- **429 is terminal per browser profile**: Chrome never retries its own 429, but the Safari tier may try, because experiments proved trust is browser/profile scoped. Safari is the final tier and never retries a 429.
- **Safari owns its UI**: the Safari tier records the frontmost app, creates a uniquely marked private window, minimizes it, restores focus, performs the fetch, then closes only that marker-owned window in `finally` and restores focus again. Calls are serialized so they cannot close each other's window.

## YouTube transcripts

The old approach is dead: caption `baseUrl`s return `200` with **0 bytes** unless they carry the proof-of-origin token the player JS appends at runtime, and InnerTube API clients are rejected in the po-token crackdown.

What works: open the watch page in tier 3, click the player's CC button, and intercept the `/api/timedtext` response the player itself makes (filtered by our videoId — otherwise you capture the pre-roll ad's captions).

## Files

- `fetch-core.ts` — tier ladder (`resilientFetch`), deny detection, HTML→markdown (Readability + Turndown), pdftotext
- `browser.ts` — direct Chrome lifecycle + CDP attach, `sameOriginFetch`, `navigateAndGet` / `navigateAndEvaluate`
- `safari.ts` — minimized private-window lifecycle, focus restoration, chunked in-page fetch
- `ua.ts` — version-honest UA + client hints
- `youtube.ts` — player-intercept transcript extraction (CC click + timedtext response capture)
- `test.ts` / `eval.ts` / `smoke.ts` — live fetch spot-checks / scored tier eval / registration smoke test for `web.ts`

## Test

```sh
npm install
node test.ts [url ...]   # default: example.com, verge 400 case, M5 Ultra article, tractorsupply.com
node --experimental-strip-types eval.ts   # scored, per-tier, ground-truth strings
node smoke.ts            # verifies tool registration end-to-end
```
