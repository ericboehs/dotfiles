// qmd-memory — surface relevant context from Eric's qmd index at session start.
//
// Flow (all async, never blocks the TUI — typing latency is untouched):
//   session_start      → fire the qmd query, spawn the session exporter
//   before_agent_start → if the query already finished while the user typed,
//                        inject as a persisted hidden message (zero delay)
//   context            → otherwise append the results to the outgoing LLM
//                        messages once they arrive (non-persistent, re-applied
//                        every call until persisted — survives compaction)
//
// The daemon query goes to POST /query (plain JSON, no MCP). Toggle with
// /memory [on|off|status|show] — bare /memory flips it; show prints the last
// injected block. State persists in ~/.cache/pi-qmd-memory (default: on).
//
// Boot cost: handler registration only (<10ms).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const BASES = ["http://localhost:8181", "http://[::1]:8181"];
const STATE_FILE = `${homedir()}/.cache/pi-qmd-memory`;
const LIMIT = 3;
const TIMEOUT_MS = 10_000;
const EXPORTER = `${homedir()}/Code/github.com/ericboehs/dotfiles/bin/pi-session-export`;

interface QmdResult {
	file: string;
	title?: string;
	score: number;
	snippet?: string;
	context?: string;
}

function isEnabled(): boolean {
	try {
		return readFileSync(STATE_FILE, "utf8").trim() !== "off";
	} catch {
		return true; // default on
	}
}

function setState(on: boolean): void {
	writeFileSync(STATE_FILE, on ? "on" : "off");
}

async function qmdQuery(body: object): Promise<{ results: QmdResult[] } | null> {
	for (const base of BASES) {
		try {
			const res = await fetch(`${base}/query`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!res.ok) continue;
			return (await res.json()) as { results: QmdResult[] };
		} catch {
			// try the next base
		}
	}
	return null;
}

function spawnExporter(): void {
	try {
		const child = spawn(EXPORTER, [], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// non-fatal — the 30-min update job exports anyway
	}
}

export default function (pi: ExtensionAPI) {
	// Per-session state. queryResults is set once the session-start query
	// resolves; consumers never await it past a small race budget.
	let queryPromise: Promise<QmdResult[]> | null = null;
	let queryResults: QmdResult[] | null = null;
	let project = "";
	let persisted = false; // injected via before_agent_start (in session file)
	let contextNotified = false;
	let lastInjected = "";
	let lastInjectedTitles = "";

	function startQuery(cwd: string): void {
		project = basename(cwd);
		// Parallel scoped queries. Cross-collection vec search on this index
		// costs 8-18s (email alone is ~14s), so keep each query scoped:
		//   vec over `sessions` (~3s) → past work on this project
		//   lex over `wiki` (~0.1s)   → current-project notes
		// RRF/rerank skipped for speed; memory hints don't need perfect ranking.
		const query = (async () => {
			const [sess, wiki] = await Promise.all([
				qmdQuery({
					intent: `past sessions about ${project} (cwd: ${cwd})`,
					searches: [
						{
							type: "vec",
							query: `${project} project decisions, status, and lessons learned`,
						},
					],
					collections: ["sessions"],
					limit: 2,
					rerank: false,
				}),
				qmdQuery({
					intent: `wiki notes about ${project}`,
					searches: [{ type: "lex", query: project }],
					collections: ["wiki"],
					limit: 2,
					rerank: false,
				}),
			]);
			return [...(sess?.results ?? []), ...(wiki?.results ?? [])].slice(
				0,
				LIMIT,
			);
		})();
		queryPromise = query;
		query.then(
			(results) => {
				queryResults = results;
			},
			() => {
				queryResults = [];
			},
		);
	}

	function formatResults(results: QmdResult[]): string {
		const hits = results
			.map((r, i) => {
				const snippet = (r.snippet ?? "").replace(/\s+/g, " ").trim();
				const ctxLine = r.context ? `\n   context: ${r.context}` : "";
				return `${i + 1}. **${r.title ?? r.file}** — ${r.file} (${Math.round(r.score * 100)}%)${ctxLine}\n   ${snippet.slice(0, 300)}`;
			})
			.join("\n\n");
		return (
			`## Retrieved context (qmd memory)\n\n` +
			`Top hits from Eric's wiki and past sessions for "${project}":\n\n${hits}\n\n` +
			`Search more with: qmd query "..." (all) · qmd search "..." -c wiki · qmd search "..." -c sessions`
		);
	}

	function notifyOnce(ctx: unknown, text: string): void {
		try {
			(ctx as { ui?: { notify?: (m: string, l?: string) => void } })?.ui?.notify?.(
				text,
				"info",
			);
		} catch {
			// stale ui — skip
		}
	}

	// Kick the query off immediately so it runs while the user types.
	pi.on("session_start", (_event, ctx) => {
		spawnExporter(); // catch sessions that ended without a clean shutdown
		queryResults = null;
		persisted = false;
		contextNotified = false;
		lastInjected = "";
		if (isEnabled()) startQuery(ctx?.cwd ?? process.cwd());
	});

	// Non-blocking: inject only if the query already resolved while the user
	// typed. Never awaits — the submitted message renders instantly.
	pi.on("before_agent_start", (_event, ctx) => {
		if (persisted || !isEnabled() || !queryResults?.length) return undefined;
		persisted = true;
		lastInjected = formatResults(queryResults);
		lastInjectedTitles = queryResults
			.map((r, i) => `${i + 1}. ${r.title ?? r.file}`)
			.join("\n");
		notifyOnce(ctx, `qmd memory: ${queryResults.length} hits injected`);
		return {
			message: {
				customType: "qmd-memory",
				display: false,
				content: lastInjected,
			},
		};
	});

	// Fast-typo path: the query wasn't ready at before_agent_start. Append the
	// results to the outgoing messages once they land (≤400ms extra inside the
	// first LLM call, invisible; later calls reuse the cached results). Not
	// persisted in the session file, so it's re-applied on every call — which
	// also means it survives compaction.
	pi.on("context", async (event, ctx) => {
		const debug = process.env.QMD_MEMORY_DEBUG === "1";
		if (persisted || !isEnabled() || !queryPromise) {
			if (debug)
				console.warn(
					`[qmd-memory] context: skip (persisted=${persisted}, enabled=${isEnabled()}, hasQuery=${!!queryPromise})`,
				);
			return undefined;
		}
		const results = await Promise.race([
			queryPromise,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
		]);
		if (debug)
			console.warn(
				`[qmd-memory] context: race done, results=${results?.length ?? "null"}`,
			);
		if (persisted || !results?.length || !isEnabled()) return undefined;
		if (!lastInjected) {
			lastInjected = formatResults(results);
			lastInjectedTitles = results
				.map((r, i) => `${i + 1}. ${r.title ?? r.file}`)
				.join("\n");
		}
		if (!contextNotified) {
			contextNotified = true;
			notifyOnce(ctx, `qmd memory: ${results.length} hits injected`);
		}
		if (debug)
			console.warn(`[qmd-memory] context: appending ${results.length} hits`);
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "qmd-memory",
					content: lastInjected,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("session_shutdown", () => {
		spawnExporter();
	});

	pi.registerCommand("memory", {
		description:
			"qmd memory injection: /memory on|off|toggle|status|show (bare = toggle)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				setState(arg === "on");
			} else if (arg === "" || arg === "toggle") {
				setState(!isEnabled());
			}

			if (arg === "show") {
				ctx.ui.notify(
					lastInjectedTitles
						? `qmd memory hits this session:\n${lastInjectedTitles}`
						: "qmd memory: nothing injected this session",
					"info",
				);
				return;
			}

			ctx.ui.notify(
				`qmd memory injection: ${isEnabled() ? "ON" : "OFF"}`,
				"info",
			);
		},
	});
}