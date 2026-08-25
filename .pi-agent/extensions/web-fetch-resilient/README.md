# web_fetch (resilient) — fetch core

This directory holds the **tiered fetch core** used by `../web.ts`, which owns the `web_fetch` tool registration (single registrar — registering `web_fetch` here as well causes a tool-conflict startup error).

## Tiers

| Tier | Client | Defeats |
|---|---|---|
| 1 | plain `fetch` | nothing — the control; handles most sites |
| 2 | `curl` with a coherent browser header set (UA from the installed Chrome binary + matching `sec-ch-ua`, sec-fetch-*, brotli) | header-coherence edge blocks |
| 3 | directly launched, persistent headless Chrome + CDP attach | JS-sensor bot detection (Akamai, etc.) — executes the sensor and passes like an ordinary browser |
| 4 | dedicated minimized private Safari window (macOS) | an independent real-browser trust tier when Chrome's profile is denied/rate-limited |

`web_fetch` behavior (in `web.ts`):
- **YouTube**: `yt-dlp` first (timestamps + metadata); falls back to the player-intercept transcript below.
- **Everything else**: the tier ladder.
- PDFs: detected by content-type / `%PDF-` magic and run through `pdftotext`.

## Design notes (from Tractor Supply CLI — Akamai Sensor Research)

- **Honest reduced UA**: major version comes from the installed binary (`--version`), then uses Chrome's normal reduced form (`151.0.0.0`, not the full patch version). Set at launch so client hints follow — a CDP-level override leaves them contradicting the header.
- **One warm profile/process**: trust is scoped to `~/.pi/agent/web-fetch-direct-profile`. Chrome intentionally outlives pi and `/reload`; the saved debugger port lets the next extension instance reattach.
- **No automation launcher**: Chrome is spawned directly with the Tractor CLI's minimum flags. Playwright only attaches afterward over CDP. A fixed nonzero port is essential—`--remote-debugging-port=0` itself sets `navigator.webdriver=true`.
- **Same-origin fallback**: after a denied navigation, warm the origin and execute `fetch()` inside that tab. Chrome supplies HttpOnly cookies, TLS/H2 fingerprint, and reserved headers coherently; TSC waits for `_abck` validation before spending the request.
- **Explicit deny detection**: challenge markers (`edgesuite`, `cf-chl`, Incapsula…) on a 200 are reported as denials, never as successful empty fetches.
- **429 is terminal per browser profile**: Chrome never retries its own 429, but tier 4 may try Safari because experiments proved trust is browser/profile scoped. Safari is the final tier and never retries a 429.
- **Safari owns its UI**: tier 4 records the frontmost app, creates a uniquely marked private window, minimizes it, restores focus, performs the fetch, then closes only that marker-owned window in `finally` and restores focus again. Calls are serialized so they cannot close each other's window.

## YouTube transcripts

The old approach is dead: caption `baseUrl`s return `200` with **0 bytes** unless they carry the proof-of-origin token the player JS appends at runtime, and InnerTube API clients are rejected in the po-token crackdown.

What works: open the watch page in tier 3, click the player's CC button, and intercept the `/api/timedtext` response the player itself makes (filtered by our videoId — otherwise you capture the pre-roll ad's captions).

## Files

- `fetch-core.ts` — tier ladder (`resilientFetch`), deny detection, HTML→markdown (Readability + Turndown), pdftotext
- `browser.ts` — direct Chrome lifecycle + CDP attach, `sameOriginFetch`, `navigateAndGet` / `navigateAndEvaluate`
- `safari.ts` — minimized private-window lifecycle, focus restoration, chunked in-page fetch
- `ua.ts` — version-honest UA + client hints
- `youtube.ts` — player-intercept transcript extraction (CC click + timedtext response capture)
- `test.ts` / `smoke.ts` — live fetch tests / registration smoke test for `web.ts`

## Test

```sh
npm install
node test.ts [url ...]   # default: example.com, verge 400 case, M5 Ultra article, tractorsupply.com
node smoke.ts            # verifies tool registration end-to-end
```
