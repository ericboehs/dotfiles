// qmd-memory — surface relevant context from Eric's qmd index at session start.
//
// On session_start it fires an async query against the local qmd HTTP daemon
// (POST /query — plain JSON, no MCP) scoped to the current project, and injects
// the top hits as hidden context (display:false, no turn triggered) so they're
// available to the model without any boot cost. On session_start/shutdown it
// also spawns the incremental session exporter so transcripts reach the
// `sessions` collection quickly.
//
// Toggle with /memory [on|off|status] — bare /memory flips it. State persists
// in ~/.cache/pi-qmd-memory (default: on).
//
// Boot cost: handler registration only (<10ms). All qmd work is async.

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
	let pendingQuery: Promise<QmdResult[]> | null = null;
	let injected = false;

	function startQuery(cwd: string): void {
		if (pendingQuery) return;
		const project = basename(cwd);
		pendingQuery = (async () => {
			// Parallel scoped queries. Cross-collection vec search on this index
			// costs 8-18s (email alone is ~14s), which races the user's first turn
			// and usually loses. Splitting by collection keeps each query fast:
			//   vec over `sessions` (~3s) → past work on this project
			//   lex over `wiki` (~0.1s)   → current-project notes
			// RRF/rerank skipped for speed; memory hints don't need perfect ranking.
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
		pendingQuery.catch(() => {}); // avoid unhandled rejection; consumers guard
	}

	function formatResults(results: QmdResult[], project: string): string {
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

	// Kick the query off immediately so it runs while the user types. If it's
	// done by the first prompt, before_agent_start injects with zero latency.
	pi.on("session_start", (_event, ctx) => {
		spawnExporter(); // catch sessions that ended without a clean shutdown
		if (!isEnabled()) return;
		injected = false;
		pendingQuery = null;
		startQuery(ctx?.cwd ?? process.cwd());
	});
		// Inject at the first prompt if the query is ready (zero added latency);
	// otherwise let the query land late via sendMessage below.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (injected || !isEnabled() || !pendingQuery) return undefined;
		const query = pendingQuery;
		const results = await Promise.race([
			query,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
		]);
		if (injected || !isEnabled()) return undefined;
		if (results && results.length) {
			injected = true;
			ctx?.ui?.notify(`qmd memory: ${results.length} hits injected`, "info");
			return {
				message: {
					customType: "qmd-memory",
					display: false,
					content: formatResults(results, basename(process.cwd())),
				},
			};
		}
		// Query still in flight — inject via sendMessage whenever it lands.
		void query
			.then((res) => {
				if (injected || !res?.length || !isEnabled()) return;
				injected = true;
				void ctx?.ui?.notify(
					`qmd memory: ${res.length} hits injected (late)`,
					"info",
				);
				return pi.sendMessage({
					customType: "qmd-memory",
					display: false,
					content: formatResults(res, basename(process.cwd())),
				});
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				// Benign: -p/automation sessions may tear down before the late
				// injection lands. Interactive sessions rebind on /new etc.
				if (!msg.includes("stale")) {
					console.warn("[qmd-memory] late injection failed:", msg);
				}
			});
		return undefined;
	});

	pi.on("session_shutdown", () => {
		spawnExporter();
	});

	pi.registerCommand("memory", {
		description:
			"Toggle qmd session-start context injection (/memory, /memory on|off|status)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				setState(arg === "on");
			} else if (arg === "" || arg === "toggle") {
				setState(!isEnabled());
			} // "status" and anything else just reports

			ctx.ui.notify(
				`qmd memory injection: ${isEnabled() ? "ON" : "OFF"}`,
				"info",
			);
		},
	});
}