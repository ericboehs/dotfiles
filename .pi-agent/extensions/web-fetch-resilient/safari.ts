/**
 * safari.ts — tier-4 transport using a dedicated minimized private Safari window.
 *
 * Actual Safari has no headless mode. This is the closest honest equivalent:
 * an ordinary private window owned by pi, minimized after creation, with a
 * permanent sentinel tab and a separate work tab. Existing user windows/tabs
 * are never navigated, inspected, or closed.
 *
 * Fetch runs inside the work tab, inheriting Safari's cookies and network
 * fingerprint. Bodies are base64'd in-page and collected in chunks because
 * Apple Events has practical string-size limits and osascript appends newlines.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MARKER = "about:blank#pi-web-fetch-transport";
const FETCH_TIMEOUT_MS = 45_000;
const MAX_BASE64_CHARS = 32 * 1024 * 1024; // ~24 MiB response ceiling
const CHUNK_CHARS = 60_000; // divisible by 4; safe below Apple Events limits

interface SafariTransport {
	windowId: number;
	workTabIndex: number;
}

interface SafariFetchOptions {
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export interface SafariFetchResult {
	status: number;
	contentType: string;
	finalUrl: string;
	bytes: Buffer;
}

let ensuring: Promise<SafariTransport> | null = null;
let safariQueue: Promise<void> = Promise.resolve();

function runAppleScript(script: string, args: string[] = [], timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("osascript", ["-", ...args], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Safari AppleScript timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout.trimEnd());
			else reject(new Error(stderr.trim() || `osascript exited ${code}`));
		});
		child.stdin.end(script);
	});
}

const FIND_TRANSPORT = String.raw`
tell application "Safari"
  repeat with w in windows
    set hasMarker to false
    repeat with t in tabs of w
      try
        if (URL of t) is "${MARKER}" then set hasMarker to true
      end try
    end repeat
    if hasMarker then
      set workTab to missing value
      repeat with t in tabs of w
        try
          if (URL of t) is not "${MARKER}" then
            set workTab to t
            exit repeat
          end if
        end try
      end repeat
      if workTab is missing value then
        set workTab to make new tab at end of tabs of w with properties {URL:"about:blank"}
      end if
      set current tab of w to workTab
      return (id of w as text) & (ASCII character 9) & (index of workTab as text)
    end if
  end repeat
end tell
return ""
`;

const CREATE_TRANSPORT = String.raw`
tell application "System Events"
  set previousApp to name of first application process whose frontmost is true
end tell

tell application "Safari"
  set oldIds to id of every window
  activate
end tell

delay 0.5
tell application "System Events" to tell process "Safari"
  keystroke "n" using {command down, shift down}
end tell

set newId to missing value
repeat 30 times
  delay 0.25
  tell application "Safari"
    repeat with w in windows
      if (id of w) is not in oldIds then
        set newId to id of w
        exit repeat
      end if
    end repeat
  end tell
  if newId is not missing value then exit repeat
end repeat

if newId is missing value then
  tell application "System Events"
    if exists application process previousApp then set frontmost of application process previousApp to true
  end tell
  error "Safari did not create a private transport window"
end if

tell application "Safari"
  set transportWindow to first window whose id is newId
  set URL of current tab of transportWindow to "${MARKER}"
  set workTab to make new tab at end of tabs of transportWindow with properties {URL:"about:blank"}
  set current tab of transportWindow to workTab
end tell

delay 0.25
tell application "System Events" to tell process "Safari"
  set value of attribute "AXMinimized" of window 1 to true
end tell

tell application "System Events"
  if exists application process previousApp then set frontmost of application process previousApp to true
end tell

return (newId as text) & (ASCII character 9) & (index of workTab as text)
`;

function parseTransport(raw: string): SafariTransport | null {
	const [windowRaw, tabRaw] = raw.trim().split("\t");
	const windowId = Number(windowRaw);
	const workTabIndex = Number(tabRaw);
	return Number.isInteger(windowId) && Number.isInteger(workTabIndex)
		? { windowId, workTabIndex }
		: null;
}

async function ensureTransport(): Promise<SafariTransport> {
	if (process.platform !== "darwin") throw new Error("Safari tier is available only on macOS");
	const running = await runAppleScript(String.raw`
tell application "System Events"
  return exists application process "Safari"
end tell
`);
	if (running !== "true") {
		throw new Error("Safari tier requires Safari to already be running");
	}
	if (!ensuring) {
		ensuring = (async () => {
			const found = parseTransport(await runAppleScript(FIND_TRANSPORT));
			if (found) return found;
			const created = parseTransport(await runAppleScript(CREATE_TRANSPORT, [], 45_000));
			if (!created) throw new Error("Safari transport window was created but could not be identified");
			return created;
		})().finally(() => {
			ensuring = null;
		});
	}
	return ensuring;
}

async function frontmostApp(): Promise<string> {
	return runAppleScript(String.raw`
tell application "System Events"
  return name of first application process whose frontmost is true
end tell
`);
}

async function restoreFocus(appName: string): Promise<void> {
	if (!appName) return;
	await runAppleScript(
		String.raw`
on run argv
  set appName to item 1 of argv
  tell application "System Events"
    if exists application process appName then set frontmost of application process appName to true
  end tell
end run
`,
		[appName],
	).catch(() => {});
}

/** Close only a window that still contains our sentinel tab. */
async function closeTransport(transport?: SafariTransport): Promise<void> {
	await runAppleScript(
		String.raw`
on run argv
  set wantedId to (item 1 of argv) as integer
  tell application "Safari"
    repeat with w in windows
      if wantedId is 0 or (id of w) is wantedId then
        set owned to false
        repeat with t in tabs of w
          try
            if (URL of t) is "${MARKER}" then set owned to true
          end try
        end repeat
        if owned then
          close w
          return "closed"
        end if
      end if
    end repeat
  end tell
  return "not-found"
end run
`,
		[String(transport?.windowId ?? 0)],
	).catch(() => {});
}

async function doJavaScript(transport: SafariTransport, script: string): Promise<string> {
	const appleScript = String.raw`
on run argv
  set windowId to (item 1 of argv) as integer
  set tabIndex to (item 2 of argv) as integer
  set scriptText to item 3 of argv
  tell application "Safari"
    set w to first window whose id is windowId
    set t to tab tabIndex of w
    return do JavaScript scriptText in t
  end tell
end run
`;
	return runAppleScript(appleScript, [String(transport.windowId), String(transport.workTabIndex), script]);
}

async function navigate(transport: SafariTransport, url: string, timeoutMs: number): Promise<void> {
	const appleScript = String.raw`
on run argv
  set windowId to (item 1 of argv) as integer
  set tabIndex to (item 2 of argv) as integer
  set targetUrl to item 3 of argv
  tell application "Safari"
    set w to first window whose id is windowId
    set URL of tab tabIndex of w to targetUrl
  end tell
end run
`;
	await runAppleScript(appleScript, [String(transport.windowId), String(transport.workTabIndex), url]);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await doJavaScript(transport, "document.readyState")) === "complete") return;
		} catch {
			/* page is between documents */
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Safari did not finish loading ${url} within ${timeoutMs}ms`);
}

async function waitForOriginTrust(transport: SafariTransport, hostname: string): Promise<void> {
	if (hostname.endsWith("tractorsupply.com")) {
		const stateScript = `(() => { const c = document.cookie.split('; ').find(x => x.startsWith('_abck=')); if (!c) return 'missing'; const p = c.split('~'); return p.length >= 4 && p[p.length - 3] !== '-1' ? 'validated' : 'pending'; })()`;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if ((await doJavaScript(transport, stateScript).catch(() => "missing")) === "validated") return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("Safari origin loaded but Akamai did not validate the session within 30s");
	}
	await new Promise((resolve) => setTimeout(resolve, 1_500));
}

/** Fetch URL through one owned minimized private Safari window. */
async function performSafariFetch(
	url: string,
	opts: SafariFetchOptions,
	transport: SafariTransport,
): Promise<SafariFetchResult> {
	const target = new URL(url);
	if (!/^https?:$/.test(target.protocol)) throw new Error("Safari fetch supports only http(s) URLs");
	const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

	await navigate(transport, `${target.origin}/`, timeoutMs);
	await waitForOriginTrust(transport, target.hostname);

	const key = `__piWebFetch_${randomUUID().replaceAll("-", "")}`;
	const startScript = `(() => {
  const key = ${JSON.stringify(key)};
  window[key] = {state:'pending'};
  fetch(${JSON.stringify(url)}, {credentials:'include', headers:${JSON.stringify(opts.headers ?? {})}})
    .then(async response => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const body = btoa(binary);
      window[key] = {state:'done', status:response.status,
        contentType:response.headers.get('content-type') || '',
        finalUrl:response.url || ${JSON.stringify(url)}, body};
    })
    .catch(error => { window[key] = {state:'error', message:String(error)}; });
  return 'started';
})()`;
	await doJavaScript(transport, startScript);

	const deadline = Date.now() + timeoutMs;
	let meta: any = null;
	while (Date.now() < deadline) {
		const raw = await doJavaScript(
			transport,
			`(() => { const o = window[${JSON.stringify(key)}]; if (!o) return 'null'; return JSON.stringify({state:o.state,status:o.status,contentType:o.contentType,finalUrl:o.finalUrl,length:o.body?.length,message:o.message}); })()`,
		);
		try {
			meta = JSON.parse(raw);
		} catch {
			meta = null;
		}
		if (meta?.state === "done") break;
		if (meta?.state === "error") throw new Error(`Safari in-page fetch failed: ${meta.message}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (meta?.state !== "done") throw new Error(`Safari in-page fetch timed out after ${timeoutMs}ms`);
	if (!Number.isInteger(meta.length) || meta.length < 0 || meta.length > MAX_BASE64_CHARS) {
		throw new Error(`Safari response base64 length ${meta.length} exceeds safety limit`);
	}

	let base64 = "";
	for (let offset = 0; offset < meta.length; offset += CHUNK_CHARS) {
		base64 += await doJavaScript(
			transport,
			`window[${JSON.stringify(key)}].body.slice(${offset}, ${offset + CHUNK_CHARS})`,
		);
	}
	await doJavaScript(transport, `delete window[${JSON.stringify(key)}]; 'cleared'`).catch(() => {});

	return {
		status: Number(meta.status),
		contentType: String(meta.contentType ?? ""),
		finalUrl: String(meta.finalUrl ?? url),
		bytes: Buffer.from(base64, "base64"),
	};
}

/**
 * Serialize Safari use: each call owns exactly one private window and closes
 * it in finally. Focus is restored after creation and again after teardown.
 */
export function safariFetch(
	url: string,
	opts: SafariFetchOptions = {},
): Promise<SafariFetchResult> {
	const run = async (): Promise<SafariFetchResult> => {
		const previousApp = await frontmostApp();
		let transport: SafariTransport | undefined;
		try {
			transport = await ensureTransport();
			// CREATE_TRANSPORT already restores focus; repeat defensively in case
			// Safari or System Events changed it while discovering the window.
			await restoreFocus(previousApp);
			return await performSafariFetch(url, opts, transport);
		} finally {
			// If creation partially succeeded, id=0 finds and closes only a window
			// that still contains our sentinel. User-owned windows never match.
			await closeTransport(transport);
			await restoreFocus(previousApp);
		}
	};

	const result = safariQueue.then(run, run);
	safariQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
