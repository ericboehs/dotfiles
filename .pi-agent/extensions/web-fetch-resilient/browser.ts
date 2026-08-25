/**
 * browser.ts — tier-3 transport: directly launched, long-lived Chrome.
 *
 * This intentionally mirrors tractor-supply-cli's proven transport shape:
 *  - launch the installed Chrome ourselves with the minimum flag set;
 *  - use a fixed, nonzero debugger port (`port=0` sets webdriver=true);
 *  - attach afterward over CDP — CDP is not the automation tell;
 *  - keep one persistent profile and browser process across pi reloads;
 *  - set the reduced, version-honest UA at launch so client hints follow.
 *
 * Playwright is only the CDP client. It never launches the browser, so none of
 * its default launcher flags or Emulation.setAutomationOverride are involved.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { chromeBinary, userAgentString } from "./ua.ts";

const STARTUP_TIMEOUT_MS = 30_000;
const PORT_FILE = ".pi-web-fetch-port";

export function defaultProfileDir(): string {
	const dir = join(homedir(), ".pi", "agent", "web-fetch-direct-profile");
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface BrowserState {
	browser: Browser;
	context: BrowserContext;
	child: ChildProcess | null;
	port: number;
	profileDir: string;
}

let state: BrowserState | null = null;
let launching: Promise<BrowserState> | null = null;

async function freeFixedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("could not allocate a debugger port"));
				return;
			}
			const port = address.port;
			server.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

async function cdpResponding(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(1_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function savedPort(profileDir: string): number | null {
	try {
		const value = Number(JSON.parse(readFileSync(join(profileDir, PORT_FILE), "utf8")).port);
		return Number.isInteger(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

async function attach(
	port: number,
	profileDir: string,
	child: ChildProcess | null,
): Promise<BrowserState> {
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const context = browser.contexts()[0];
	if (!context) {
		await browser.close().catch(() => {});
		throw new Error("direct Chrome exposed no default browser context");
	}
	const next = { browser, context, child, port, profileDir };
	browser.on("disconnected", () => {
		if (state?.browser === browser) state = null;
	});
	state = next;
	return next;
}

async function launchDirect(profileDir: string): Promise<BrowserState> {
	mkdirSync(profileDir, { recursive: true });

	// A Chrome intentionally outlives pi/reload. Reattach to it when its saved
	// endpoint still answers instead of launching against a locked profile.
	const existingPort = savedPort(profileDir);
	if (existingPort && (await cdpResponding(existingPort))) {
		return attach(existingPort, profileDir, null);
	}

	const binary = chromeBinary();
	if (!binary) throw new Error("no installed Google Chrome/Chromium binary found");
	const port = await freeFixedPort(); // nonzero is essential: 0 sets webdriver=true
	const child = spawn(
		binary,
		[
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--headless",
			`--user-agent=${userAgentString()}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	child.unref(); // browser keeps its trusted profile alive across pi exits

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline && !(await cdpResponding(port))) {
		if (child.exitCode !== null) throw new Error(`Chrome exited during startup (${child.exitCode})`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (!(await cdpResponding(port))) {
		child.kill("SIGTERM");
		throw new Error(`Chrome did not open debugger port ${port} within 30s`);
	}

	writeFileSync(join(profileDir, PORT_FILE), JSON.stringify({ port }));
	return attach(port, profileDir, child);
}

async function getState(profileDir: string): Promise<BrowserState> {
	if (state && state.profileDir === profileDir) return state;
	if (!launching) {
		launching = launchDirect(profileDir).finally(() => {
			launching = null;
		});
	}
	return launching;
}

export async function shutdownBrowser(): Promise<void> {
	const current = state;
	state = null;
	if (!current) return;
	try {
		await current.browser.close();
	} catch {
		/* already gone */
	}
	if (current.child && current.child.exitCode === null) current.child.kill("SIGTERM");
	try {
		unlinkSync(join(current.profileDir, PORT_FILE));
	} catch {
		/* already gone */
	}
}

/** Run fn with a fresh page in the persistent direct-Chrome context. */
export async function withPage<T>(
	fn: (page: Page) => Promise<T>,
	opts: { profileDir?: string } = {},
): Promise<T> {
	const current = await getState(opts.profileDir ?? defaultProfileDir());
	const page = await current.context.newPage();
	try {
		return await fn(page);
	} finally {
		await page.close().catch(() => {});
	}
}

/** Navigate to url, settle, run fn(page). */
export async function navigateAndEvaluate<R>(
	url: string,
	fn: (page: Page) => Promise<R>,
	opts: { timeoutMs?: number; profileDir?: string } = {},
): Promise<R> {
	return withPage(async (page) => {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 45_000 }).catch(() => {});
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
		return fn(page);
	}, opts);
}

/**
 * Tractor's other key trick: warm a real tab on the target origin, then issue
 * fetch() inside it. The request inherits HttpOnly cookies, browser TLS/H2,
 * and sensor trust; reserved headers are supplied coherently by Chrome.
 */
export async function sameOriginFetch(
	url: string,
	opts: { timeoutMs?: number; profileDir?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; contentType: string; finalUrl: string }> {
	const target = new URL(url);
	return withPage(async (page) => {
		await page.goto(`${target.origin}/`, {
			waitUntil: "domcontentloaded",
			timeout: opts.timeoutMs ?? 45_000,
		});
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

		// TSC exposes _abck to document.cookie; spend no request until its signed
		// middle fields replace the pending -1 placeholders. Other origins get a
		// short sensor-settle pause before the same-origin fetch.
		if (target.hostname.endsWith("tractorsupply.com")) {
			await page
				.waitForFunction(
					() => {
						const cookie = document.cookie.split("; ").find((c) => c.startsWith("_abck="));
						if (!cookie) return false;
						const parts = cookie.split("~");
						return parts.length >= 4 && parts[parts.length - 3] !== "-1";
					},
					{ timeout: 30_000 },
				)
				.catch(() => {});
		} else {
			await page.waitForTimeout(1_500);
		}

		return page.evaluate(async ({ targetUrl, headers }) => {
			const response = await window.fetch(targetUrl, {
				credentials: "include",
				headers,
			});
			return {
				status: response.status,
				body: await response.text(),
				contentType: response.headers.get("content-type") ?? "",
				finalUrl: response.url || targetUrl,
			};
		}, { targetUrl: url, headers: opts.headers ?? {} });
	}, opts);
}

/** Navigate, settle, return { status, html, finalUrl }. Status may be undefined on soft failures. */
export async function navigateAndGet(
	url: string,
	opts: { timeoutMs?: number; profileDir?: string } = {},
): Promise<{ status: number | undefined; html: string; finalUrl: string; note?: string }> {
	const timeoutMs = opts.timeoutMs ?? 45_000;
	return withPage(async (page) => {
		let status: number | undefined;
		let finalUrl = url;
		let note: string | undefined;

		// Track subsequent main-frame responses too: managed challenges often
		// begin with 403, execute JS, then navigate to a fresh 200 document.
		page.on("response", (resp) => {
			const req = resp.request();
			if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
				status = resp.status();
				finalUrl = resp.url();
			}
		});

		try {
			const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
			status = resp?.status();
			finalUrl = resp?.url() ?? url;
		} catch (e) {
			note = `goto failed: ${(e as Error).message}`;
		}
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
		await page.waitForTimeout(500);

		let html = await page.content();
		const challenge = (s: string) =>
			/just a moment|cf-chl|challenge-platform|verify you are human|checking your browser/i.test(s);
		if ((status !== undefined && (status === 403 || status === 429)) || challenge(html)) {
			const deadline = Date.now() + 12_000;
			while (Date.now() < deadline) {
				await page.waitForTimeout(500);
				html = await page.content();
				if ((!status || status < 400) && !challenge(html)) break;
			}
			note = `${note ? `${note}; ` : ""}waited for managed challenge`;
		}

		finalUrl = page.url() === "about:blank" ? finalUrl : page.url();
		return { status, html, finalUrl, note };
	}, opts);
}
