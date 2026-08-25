/**
 * youtube.ts — transcript extraction for YouTube links.
 *
 * The old trick (parse ytInitialPlayerResponse from the watch page, fetch the
 * caption baseUrl) is dead: timedtext now returns 200 with 0 bytes unless the
 * request carries a proof-of-origin token that only the player JS appends at
 * runtime. InnerTube API clients are rejected outright (po-token crackdown).
 *
 * What still works is exactly what the Akamai research prescribes: let the
 * warmed browser do it as a browser. Navigate, click the player's CC button,
 * and intercept the /api/timedtext response the player itself makes — token,
 * cookies, session all included.
 */
import { withPage } from "./browser.ts";

export function youtubeVideoId(url: string): string | null {
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^www\./, "");
		if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
		if (host.endsWith("youtube.com")) {
			const v = u.searchParams.get("v");
			if (v) return v;
			const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{6,})/);
			if (m) return m[2];
		}
	} catch {
		/* not a url */
	}
	return null;
}

/** json3 events → plain text transcript. */
function json3ToText(data: any): string {
	const events: Array<any> = data?.events ?? [];
	return events
		.filter((e) => e.segs)
		.map((e) => (e.segs as Array<{ utf8: string }>).map((s) => s.utf8).join(""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Open the watch page in the warmed browser, enable captions via the player
 * UI, and capture the timedtext response. Throws if no caption data arrives.
 */
export async function resolveYoutubeTranscript(
	url: string,
): Promise<{ videoId: string; text: string; via: "player-intercept" }> {
	const videoId = youtubeVideoId(url);
	if (!videoId) throw new Error(`not a YouTube URL: ${url}`);
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

	const captured = await withPage<string | null>(async (page) => {
		let body: string | null = null;
		page.on("response", (resp) => {
			// must match OUR videoId, or you get the pre-roll ad's captions.
			// parse the query properly — raw substring match misses encodings.
			if (body || !resp.url().includes("/api/timedtext")) return;
			try {
				if (new URL(resp.url()).searchParams.get("v") !== videoId) return;
			} catch {
				return;
			}
			resp
				.text()
				.then((t) => {
					if (t.length > 100) body = t;
				})
				.catch(() => {});
		});

		await page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

		const cc = page.locator(".ytp-subtitles-button");
		const enableCc = async () => {
			const count = await cc.count();
			if (count > 0 && (await cc.isEnabled().catch(() => false))) {
				await cc.click().catch(() => {});
				return true;
			}
			return false;
		};
		await enableCc();
		await page.waitForTimeout(3000);

		// Ad captions were filtered out; if nothing arrived yet, wait a little
		// more, re-clicking CC once in case the first toggle was swallowed by an
		// ad break or late player init.
		let retried = false;
		const deadline = Date.now() + 15_000;
		while (!body && Date.now() < deadline) {
			await page.waitForTimeout(500);
			if (!retried && Date.now() > deadline - 10_000) {
				retried = true;
				await enableCc().catch(() => {}); // off→on again re-triggers timedtext
			}
		}
		return body;
	});

	if (captured && captured.length > 100) {
		let text = "";
		try {
			text = json3ToText(JSON.parse(captured));
		} catch {
			text = "";
		}
		if (!text) throw new Error("timedtext captured but unparseable");
		return { videoId, text, via: "player-intercept" };
	}

	throw new Error(
		"no timedtext response captured — either captions failed to enable or the video has none",
	);
}
