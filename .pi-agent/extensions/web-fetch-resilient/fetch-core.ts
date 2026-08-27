/**
 * fetch-core.ts — tiered fetch with escalation.
 *
 *  1. plain fetch (current web_fetch behavior — the control)
 *  2. curl with a coherent browser header set (real Chrome UA + matching
 *     client hints) — defeats header-coherence edge blocks
 *  3. warmed headless Chrome via CDP — executes the site's bot sensor and
 *     passes it, exactly like an ordinary browser would
 *  4. minimized private Safari window — an independent browser trust tier
 *  5. Firecrawl — a paid render/extract service; last by default because it
 *     is the only tier that spends credits
 *
 * The ladder is operator-ordered (see web-providers/config.ts). Names map to
 * fixed tier numbers so result footers stay comparable across orderings.
 *
 * Deny/challenge detection is explicit: a 200 that is actually a challenge
 * page must be reported as such, never as a successful empty fetch.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { browserHeaders, userAgentString } from "./ua.ts";
import { navigateAndGet, sameOriginFetch, shutdownBrowser } from "./browser.ts";

export { shutdownBrowser };

type FetchTier = 1 | 2 | 3 | 4 | 5;

/** Stable name → tier number. Reordering never renumbers a tier. */
export const TIER_NUMBERS = { plain: 1, curl: 2, chrome: 3, safari: 4, firecrawl: 5 } as const;
export type FetchTierName = keyof typeof TIER_NUMBERS;

export interface FetchResult {
	url: string;
	finalUrl: string;
	status: number | undefined;
	tier: FetchTier;
	contentType?: string;
	content: string;
	truncated: boolean;
}

const DENY_MARKERS = [
	"access denied",
	"errors.edgesuite.net",
	"sec-if-cpt-container",
	"just a moment...",
	"attention required",
	"challenge-platform",
	"cf-chl",
	"verify you are human",
	"are you a robot",
	"request unsuccessful. incapsula",
	// Amazon's wall answers 200 and looks like a page. Measured 2026-08-25:
	// tier 2 "succeeded" on it and the ladder stopped, because nothing about
	// the status or the size said no. These three strings say no.
	"click the button below to continue shopping",
	"/errors/validatecaptcha",
	"api-services-support@amazon.com",
];

// Deliberately not a marker: "enable javascript". Half the honest web ships
// that sentence in a <noscript> it never shows, and refusing those pages would
// cost far more than the walls it caught.

/** Returns the marker if the HTML looks like a bot challenge / deny page, else null. */
export function denyMarker(html: string): string | null {
	if (!html || html.length > 2_000_000) return null; // huge pages are real pages
	const lower = html.toLowerCase();
	for (const m of DENY_MARKERS) {
		if (lower.includes(m)) return m;
	}
	return null;
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|\w+\+json))/;

function truncate(s: string, maxChars: number): [string, boolean] {
	return s.length <= maxChars ? [s, false] : [s.slice(0, maxChars), true];
}

/** HTML → readable markdown via Readability + Turndown, with a text fallback. */
export function htmlToMarkdown(html: string, url: string): string {
	try {
		// jsdom reports every CSS parse error on the real web to the console.
		// Reddit alone emits a stack trace per stylesheet, and this runs in-process
		// inside pi — so the noise lands in the user's UI, describing nothing they
		// can act on. We want the DOM, not the diagnostics.
		const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
		const doc = dom.window.document;
		// Script/style text is not the page. Leaving it in made a Next.js shell
		// extract as its __NEXT_DATA__ JSON and look like 164 characters of prose.
		for (const el of doc.querySelectorAll("script, style, noscript")) el.remove();
		const title = doc.title?.trim() ?? "";
		let articleHtml = "";
		try {
			const parsed = new Readability(doc.cloneNode(true) as any).parse();
			articleHtml = parsed?.content ?? "";
		} catch {
			articleHtml = "";
		}
		let md = "";
		if (articleHtml && articleHtml.length > 200) {
			const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
			md = td.turndown(articleHtml);
		} else {
			md = (doc.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
		}
		return title ? `# ${title}\n\n${md}` : md;
	} catch {
		return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	}
}

interface RawResult {
	status: number | undefined;
	body: string; // decoded text (tiers 3); empty for binary tiers 1–2
	bytes?: Buffer; // raw response bytes (tiers 1–2, for PDFs)
	contentType: string;
	finalUrl: string;
	note?: string;
}

function rawText(r: RawResult): string {
	return r.body || (r.bytes ? r.bytes.toString("utf8") : "");
}

function rawLen(r: RawResult): number {
	return r.bytes ? r.bytes.length : r.body.length;
}

/** Tier 1 — plain fetch, identical in spirit to the built-in tool. */
async function tier1(url: string, signal?: AbortSignal): Promise<RawResult> {
	const signals = [AbortSignal.timeout(20_000), ...(signal ? [signal] : [])];
	const res = await fetch(url, { redirect: "follow", signal: AbortSignal.any(signals) });
	const bytes = Buffer.from(await res.arrayBuffer());
	return { status: res.status, body: "", bytes, contentType: res.headers.get("content-type") ?? "", finalUrl: res.url };
}

/** Tier 2 — curl with the full coherent header set; brotli-capable like a real browser. */
async function tier2(url: string, signal?: AbortSignal): Promise<RawResult> {
	const dir = await mkdtemp(join(tmpdir(), "pifetch-"));
	const bodyFile = join(dir, "body");
	try {
		const args = ["-sS", "-L", "--compressed", "--max-time", "25"];
		for (const [k, v] of browserHeaders()) args.push("-H", `${k}: ${v}`);
		args.push("-o", bodyFile, "-w", "%{http_code}\t%{url_effective}", url);
		const out = await new Promise<string>((resolve, reject) => {
			const p = spawn("curl", args, { signal });
			let stdout = "";
			let stderr = "";
			p.stdout.on("data", (d) => (stdout += d));
			p.stderr.on("data", (d) => (stderr += d));
			p.on("error", reject);
			p.on("close", (code) =>
				code === 0 ? resolve(stdout) : reject(new Error(`curl exit ${code}: ${stderr.trim()}`)),
			);
		});
		const [statusStr, finalUrl] = out.trim().split("\t");
		const bytes = await readFile(bodyFile).catch(() => Buffer.alloc(0));
		return { status: Number(statusStr) || undefined, body: "", bytes, contentType: "", finalUrl };
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Tier 3 — direct-launched Chrome. Navigate first so rendered sites and
 * managed challenges work normally. If the target is denied, switch to the
 * Tractor transport shape: warm a tab on the origin, wait for sensor trust,
 * and issue a same-origin fetch() carrying Chrome's cookies and fingerprint.
 */
async function tier3(
	url: string,
	profileDir?: string,
	headers?: Record<string, string>,
): Promise<RawResult> {
	let r = await navigateAndGet(url, { profileDir });
	let note = r.note;
	// A 429 from real Chrome is the site's actual cooldown. Retrying can extend
	// it, so unlike a 403 challenge it is terminal at this tier.
	if (r.status === 429) {
		return {
			status: r.status,
			body: r.html,
			contentType: "text/html",
			finalUrl: r.finalUrl,
			note: r.note,
		};
	}
	const blocked = denyMarker(r.html) || r.status === 403;
	if (blocked) {
		try {
			const fetched = await sameOriginFetch(url, { profileDir, headers });
			note = `navigation denied; same-origin fetch status=${fetched.status}`;
			if (
				(fetched.status >= 200 && fetched.status < 300 && !denyMarker(fetched.body)) ||
				fetched.status === 429
			) {
				return {
					status: fetched.status,
					body: fetched.body,
					contentType: fetched.contentType,
					finalUrl: fetched.finalUrl,
					note,
				};
			}
			// The warm-up may still have improved the profile; retry navigation
			// once before declaring the browser path denied.
			r = await navigateAndGet(url, { profileDir });
		} catch (e) {
			note = `same-origin browser fetch failed: ${(e as Error).message}`;
		}
	}
	return {
		status: r.status,
		body: r.html,
		contentType: "text/html",
		finalUrl: r.finalUrl,
		note,
	};
}

/**
 * Tier 5 — Firecrawl scrape. Costs a credit per page, so it sits last by
 * default and only runs once the free local tiers have denied or come back
 * empty. Returns markdown, which finish() passes through untouched.
 */
async function tier5(url: string, key?: string, signal?: AbortSignal): Promise<RawResult> {
	if (!key) throw new Error("no FIRECRAWL_API_KEY (env or fnox)");
	const signals = [AbortSignal.timeout(60_000), ...(signal ? [signal] : [])];
	const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
		signal: AbortSignal.any(signals),
	});
	const json = (await res.json().catch(() => ({}))) as any;
	if (!res.ok || json?.success === false) {
		const detail = JSON.stringify(json?.error ?? json ?? {}).slice(0, 200);
		throw new Error(`firecrawl ${res.status}: ${detail}`);
	}
	const meta = json?.data?.metadata ?? {};
	return {
		status: typeof meta.statusCode === "number" ? meta.statusCode : res.status,
		body: String(json?.data?.markdown ?? ""),
		contentType: "text/markdown",
		finalUrl: meta.sourceURL ?? meta.url ?? url,
		note: "firecrawl scrape",
	};
}

/** Tier 4 — dedicated minimized private Safari window (macOS only). */
async function tier4(url: string, headers?: Record<string, string>): Promise<RawResult> {
	const { safariFetch } = await import("./safari.ts");
	const r = await safariFetch(url, { headers });
	return {
		status: r.status,
		body: "",
		bytes: r.bytes,
		contentType: r.contentType,
		finalUrl: r.finalUrl,
	};
}

function acceptable(r: RawResult): boolean {
	if (rawLen(r) === 0) return false;
	if (r.status !== undefined && r.status >= 400) return false;
	const text = rawText(r);
	if (denyMarker(text)) return false;
	if (isPdf(r)) return true; // PDFs are validated by pdftotext in finish()
	if (r.contentType && !TEXTUAL.test(r.contentType)) {
		// unknown content type with a 200 and a real-sized body — accept
		return rawLen(r) > 100;
	}
	// Firecrawl (tier 5) returns already-extracted markdown rather than a raw
	// document, so its length is prose length. example.com is 167 characters of
	// real page; the raw-size floor below would call that a failed fetch.
	if (r.contentType === "text/markdown") return true;
	// textual: guard against suspiciously tiny "successes"
	return !(rawLen(r) < 400 && r.finalUrl.includes(".com"));
}

function isPdf(r: RawResult): boolean {
	return (
		r.contentType.includes("pdf") ||
		/\.pdf([?#]|$)/i.test(r.finalUrl) ||
		(r.bytes && r.bytes.subarray(0, 5).toString("latin1") === "%PDF-") === true
	);
}

async function pdfToText(bytes: Buffer): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pifetch-pdf-"));
	const file = join(dir, "doc.pdf");
	try {
		await import("node:fs/promises").then((fs) => fs.writeFile(file, bytes));
		return await new Promise<string>((resolve, reject) => {
			const p = spawn("pdftotext", ["-layout", file, "-"]);
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.on("error", (e) => reject(new Error(`pdftotext not available: ${e.message}`)));
			p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`pdftotext exited ${code}`))));
		});
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Whether an extracted result is too thin to be the page that was asked for.
 *
 * Judged *after* extraction, which is the whole point. `acceptable()` reads the
 * response; this reads the answer. A JavaScript application shell is a large,
 * well-formed, 200-status document containing no prose at all — Reddit came
 * back `200 · complete` with an empty body that way, having passed every check
 * that looked only at the bytes.
 *
 * Size is half the judgement. example.com is 1.2KB of HTML and 167 characters
 * of prose, and that is the entire page — not a shell. Only a document big
 * enough to have had something to say is suspicious for saying nothing.
 */
const THIN_CHARS = 200;
const SHELL_BYTES = 8_000;

/**
 * Compact JavaScript application shells. These are well-formed 200s that
 * contain no document — just an empty mount point and the script that would
 * have filled it. They sit well under SHELL_BYTES (Next.js empty exports are
 * ~2KB) so the size half of thin() never fires on them.
 *
 * Measured 2026-08-26: gatesnotes.com answered 200 with a 2.1KB Next.js
 * export (`<div id="__next"></div>` + empty pageProps). The ladder stopped
 * at tier 1 holding the JSON blob as if it were the article.
 */
export function looksLikeJsShell(html: string): boolean {
	if (!html) return false;
	// Next.js: empty root + __NEXT_DATA__. The article lives in the client
	// bundle; nothing was rendered into the HTML.
	if (/<div id=["']__next["']>\s*<\/div>/i.test(html) && /id=["']__NEXT_DATA__["']/i.test(html)) {
		return true;
	}
	// React/Vite/etc.: empty #root/#app and almost no remaining prose.
	if (/<div id=["'](?:root|app)["']>\s*<\/div>/i.test(html)) {
		const without = html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
		const text = without.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		return text.length < 80;
	}
	return false;
}

function thin(result: FetchResult, raw: RawResult): boolean {
	if (isPdf(raw)) return false; // pdftotext already validated these
	if (result.truncated) return false; // truncation means there was plenty
	if (raw.contentType && !TEXTUAL.test(raw.contentType)) return false; // size-checked in acceptable()
	// Compact SPA shells never reach SHELL_BYTES, but they are not the page.
	if (looksLikeJsShell(rawText(raw))) return true;
	// Drop the `# Title` line and the footer finish() adds: a shell has a title
	// and nothing else, and the footer is never evidence of content.
	const body = result.content.replace(/^#[^\n]*\n/, "").split("\n\n---\n[via tier")[0].trim();
	if (body.length >= THIN_CHARS) return false;
	return rawLen(raw) >= SHELL_BYTES;
}

function tierDescription(tier: FetchTier): string {
	if (tier === 2) return ": curl w/ browser headers";
	if (tier === 3) return ": headless Chrome";
	if (tier === 4) return ": private Safari";
	if (tier === 5) return ": Firecrawl";
	return "";
}

async function finish(
	url: string,
	tier: FetchTier,
	raw: RawResult,
	maxChars: number,
	caveat = "",
): Promise<FetchResult> {
	let content: string;
	let extraNote = "";
	if (isPdf(raw) && raw.bytes) {
		content = await pdfToText(raw.bytes); // throws → tier marked failed by caller? no: finish is called on accepted results only
		extraNote = " · pdftotext";
	} else {
		const bodyText = rawText(raw);
		const isHtml =
			raw.contentType.includes("html") || /^\s*<(!doctype|html)/i.test(bodyText.slice(0, 200));
		content = isHtml ? htmlToMarkdown(bodyText, raw.finalUrl) : bodyText;
	}
	const [text, truncated] = truncate(content, maxChars);
	return {
		url,
		finalUrl: raw.finalUrl,
		status: raw.status,
		tier,
		contentType: raw.contentType || undefined,
		content:
			text +
			`\n\n---\n[via tier ${tier}${tierDescription(tier)}${extraNote} · status ${raw.status ?? "?"}${raw.status && raw.status >= 400 ? " — genuine upstream error page" : ""} · ${truncated ? "truncated" : "complete"}${caveat}]`,
		truncated,
	};
}

export interface FetchOptions {
	maxChars?: number;
	profileDir?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onAttempt?: (msg: string) => void;
	/** Tier names in the order to try them. Defaults to the full local-first ladder. */
	order?: FetchTierName[];
	/** Required for the firecrawl tier; resolved by the caller so this module owns no secrets. */
	firecrawlKey?: string;
}

const DEFAULT_ORDER: FetchTierName[] = ["plain", "curl", "chrome", "safari", "firecrawl"];

/**
 * Fetch `url` through the tier ladder. Returns the first acceptable result,
 * annotated with the tier that produced it. Throws only when every tier fails.
 */
export async function resilientFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
	const attempts: string[] = [];

	// YouTube gets special handling: transcripts, not HTML.
	const yt = url.match(/(?:youtube\.com\/watch\?[^ ]*v=|youtu\.be\/)([\w-]{6,})/);
	if (yt) {
		const { resolveYoutubeTranscript } = await import("./youtube.ts");
		try {
			const t = await resolveYoutubeTranscript(url);
			const header = `Transcript for https://www.youtube.com/watch?v=${t.videoId} (${t.via} path):\n\n`;
			const [text, truncated] = truncate(header + t.text, opts.maxChars ?? 20_000);
			return {
				url,
				finalUrl: `https://www.youtube.com/watch?v=${t.videoId}`,
				status: 200,
				tier: 3, // always: player-intercept runs in the warmed browser
				contentType: "text/plain",
				content: text,
				truncated,
			};
		} catch (e) {
			attempts.push(`youtube: ${(e as Error).message}`);
		}
	}

	const runners: Record<FetchTierName, () => Promise<RawResult>> = {
		plain: () => tier1(url, opts.signal),
		curl: () => tier2(url, opts.signal),
		chrome: () => tier3(url, opts.profileDir, opts.headers),
		safari: () => tier4(url, opts.headers),
		firecrawl: () => tier5(url, opts.firecrawlKey, opts.signal),
	};
	const order = opts.order?.length ? opts.order : DEFAULT_ORDER;
	const tiers: Array<[FetchTier, () => Promise<RawResult>]> = order.map((name) => [
		TIER_NUMBERS[name],
		runners[name],
	]);

	let lastBrowserRaw: RawResult | null = null;
	let lastBrowserTier: FetchTier = 3;
	// The best thin answer seen so far. A shell from tier 1 is worthless when
	// tier 4 can render the page, but it beats throwing if nothing else lands.
	let bestThin: { raw: RawResult; tier: FetchTier; len: number } | null = null;
	for (const [tier, run] of tiers) {
		try {
			opts.onAttempt?.(
				`tier ${tier}${tier === 3 ? " (headless chrome)" : tier === 4 ? " (private Safari)" : tier === 5 ? " (Firecrawl)" : ""}...`,
			);
			const raw = await run();
			// Only real browsers earn the "this 4xx is genuine" fallback below;
			// a Firecrawl error page is the vendor's opinion, not the origin's.
			if (tier === 3 || tier === 4) {
				lastBrowserRaw = raw;
				lastBrowserTier = tier;
			}
			if (acceptable(raw)) {
				const result = await finish(url, tier, raw, opts.maxChars ?? 20_000);
				if (!thin(result, raw)) return result;
				// Extracted to almost nothing: an app shell, or a wall with no
				// marker in it. Either way this tier did not answer the question,
				// so keep climbing rather than reporting "complete".
				const len = result.content.length;
				if (!bestThin || len > bestThin.len) bestThin = { raw, tier, len };
				attempts.push(
					`tier ${tier}: status=${raw.status} len=${rawLen(raw)} but extracted no readable content`,
				);
				continue;
			}
			const marker = denyMarker(rawText(raw));
			attempts.push(
				`tier ${tier}: status=${raw.status} len=${rawLen(raw)}${marker ? ` deny-marker="${marker}"` : ""}${raw.note ? ` note="${raw.note}"` : ""}`,
			);
		} catch (e) {
			attempts.push(`tier ${tier}: ${(e as Error).message}`);
		}
	}

	// If even real Chrome got a >= 400 with a rendered body, that status is
	// genuine — hand back the error page instead of failing outright. Reuse
	// the response we already have; never spend another browser request here.
	if (
		lastBrowserRaw?.status &&
		lastBrowserRaw.status >= 400 &&
		rawLen(lastBrowserRaw) > 500 &&
		!denyMarker(rawText(lastBrowserRaw))
	) {
		return await finish(url, lastBrowserTier, lastBrowserRaw, opts.maxChars ?? 20_000);
	}

	// Every tier that answered at all answered with a shell. Hand back the
	// fullest of them, saying so: an empty page the caller can see through is a
	// better outcome than an exception that hides one was served.
	if (bestThin) {
		return await finish(
			url,
			bestThin.tier,
			bestThin.raw,
			opts.maxChars ?? 20_000,
			" · WARNING: no readable content extracted — likely a JS app shell or an unrecognised bot wall",
		);
	}

	// Preserve the live browser/profile even on failure. Its accumulated sensor
	// trust is the scarce resource; tests and explicit teardown call
	// shutdownBrowser() themselves.
	throw new Error(
		`all fetch tiers failed for ${url}\n  - ${attempts.join("\n  - ")}\nUA sent: ${userAgentString()}`,
	);
}
