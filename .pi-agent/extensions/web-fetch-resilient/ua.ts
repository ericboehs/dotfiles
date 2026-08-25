/**
 * ua.ts — honest Chrome identity.
 *
 * Per the Akamai research: a UA naming a Chrome newer than the engine behind
 * it is a worse tell than HeadlessChrome. Build the UA from the version the
 * installed binary reports, and keep client hints consistent with it.
 */
import { spawnSync } from "node:child_process";

const CHROME_CANDIDATES =
	process.platform === "darwin"
		? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
		: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "chromium"];

let cachedUA: string | null = null;
let cachedVersion = "";

export function chromeBinary(): string | null {
	for (const c of CHROME_CANDIDATES) {
		try {
			const r = spawnSync(c, ["--version"], { timeout: 5000 });
			if (r.status === 0 && r.stdout) return c;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Real Chrome major.minor.build.patch from the binary itself. */
export function chromeVersion(): string {
	if (cachedVersion) return cachedVersion;
	const bin = chromeBinary();
	if (!bin) return "";
	try {
		const r = spawnSync(bin, ["--version"], { timeout: 5000 });
		const m = String(r.stdout ?? "").match(/\d+(\.\d+){3}/);
		if (m) cachedVersion = m[0];
	} catch {
		/* leave empty */
	}
	return cachedVersion;
}

/**
 * UA built from the installed binary's major version. Modern Chrome reduces
 * its public UA to `<major>.0.0.0`; exposing the full patch version would
 * contradict what an ordinary Chrome reports and is therefore less honest.
 */
export function userAgentString(): string {
	if (cachedUA) return cachedUA;
	const major = chromeVersion().split(".")[0] || "130";
	cachedUA =
		`Mozilla/5.0 (${process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64"}) ` +
		`AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
	return cachedUA;
}

/** sec-ch-ua brands matching the same version, so hints don't contradict the header. */
export function secChUa(): string {
	const major = chromeVersion().split(".")[0] || "130";
	return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not=A?Brand";v="24"`;
}

/** Flat list of coherent browser headers for curl / fetch. */
export function browserHeaders(): Array<[string, string]> {
	const ua = userAgentString();
	return [
		["User-Agent", ua],
		[
			"Accept",
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		],
		["Accept-Language", "en-US,en;q=0.9"],
		["Upgrade-Insecure-Requests", "1"],
		["Sec-Fetch-Dest", "document"],
		["Sec-Fetch-Mode", "navigate"],
		["Sec-Fetch-Site", "none"],
		["Sec-Fetch-User", "?1"],
		["sec-ch-ua", secChUa()],
		["sec-ch-ua-mobile", "?0"],
		["sec-ch-ua-platform", process.platform === "darwin" ? '"macOS"' : '"Linux"'],
	];
}
