// qmd-memory — surface relevant context from Eric's qmd index at session start.
//
// Flow (all async — typing latency is untouched, boot stays <10ms):
//   session_start      → fire the qmd query (retries while the daemon boots
//                        after login), spawn the session exporter
//   before_agent_start → if the query already finished while the user typed,
//                        inject as a persisted hidden message
//   context            → else, on the first LLM call where the query has
//                        landed, append the results to the outgoing messages
//                        (non-persistent, re-applied every call — survives
//                        compaction)
//   query resolution   → if the turn already ran without context (fast typist,
//                        single-call turn), persist-inject via sendMessage so
//                        the next turn has it
//
// A single `delivered` flag guards all three delivery paths. The daemon query
// goes to POST /query (plain JSON, no MCP). Toggle with /memory
// [on|off|toggle|status|show] — bare /memory flips it; show lists what was
// injected. State persists in ~/.cache/pi-qmd-memory (default: on).
// QMD_MEMORY_DEBUG=1 traces delivery decisions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const BASES = ["http://localhost:8181", "http://[::1]:8181"];
const STATE_FILE = `${homedir()}/.cache/pi-qmd-memory`;
const LIMIT = 3;
const TIMEOUT_MS = 30_000; // must exceed cold model-load time (~10-30s)
const RETRY_MS = 3_000;
const RETRY_MAX = 12;
const CONTEXT_RACE_MS = 2_000;
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
	return null; // transport failure (daemon down/timing out)
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
	let queryPromise: Promise<QmdResult[]> | null = null;
	let queryResults: QmdResult[] | null = null; // cached once resolved
	let project = "";
	let sessionCtx: unknown = undefined;
	let delivered = false; // any delivery path has fired
	let lastInjectedTitles = "";

	function debug(msg: string): void {
		if (process.env.QMD_MEMORY_DEBUG === "1") {
			console.warn(`[qmd-memory] ${msg}`);
		}
	}

	function notify(text: string): void {
		try {
			const ui = (
				sessionCtx as { ui?: { notify?: (m: string, l?: string) => void } }
			)?.ui;
			ui?.notify?.(text, "info");
		} catch {
			/* stale ui — skip */
		}
	}

	function cacheTitles(results: QmdResult[]): void {
		lastInjectedTitles = results
			.map((r, i) => `${i + 1}. ${r.title ?? r.file}`)
			.join("\n");
	}

	function startQuery(cwd: string): void {
		project = basename(cwd);
		// Scoped queries — cross-collection vec search costs 8-18s (email alone
		// is ~14s): vec over `sessions` (~3s) for past work, lex over `wiki`
		// (~0.1s) for current-project notes. No rerank; hints don't need it.
		const oneAttempt = async () => {
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
			// Both null = daemon unreachable (booting after login, down) → retry.
			if (sess === null && wiki === null) return null;
			return [...(sess?.results ?? []), ...(wiki?.results ?? [])].slice(
				0,
				LIMIT,
			);
		};

		queryPromise = (async () => {
			for (let i = 0; i < RETRY_MAX; i++) {
				const results = await oneAttempt();
				if (results !== null) return results;
				debug(`daemon unreachable, retry ${i + 1}/${RETRY_MAX}`);
				await new Promise((r) => setTimeout(r, RETRY_MS));
			}
			debug("daemon never came up; giving up quietly");
			return [];
		})();

		queryPromise.then((results) => {
			queryResults = results;
			if (!results.length || delivered || !isEnabled()) return;
			// Turn already ran without context (fast typist / single-call turn).
			// Persist now so the next turn has it, and ping. If sendMessage is
			// unavailable (mid-turn guard, stale session), roll back so the
			// context hook delivers instead on the next LLM call.
			delivered = true;
			cacheTitles(results);
			notify(`qmd memory: ${results.length} hits injected`);
			const rollback = (msg: string) => {
				debug(`late persist unavailable: ${msg} — deferring to context hook`);
				delivered = false;
			};
			try {
				const p = pi.sendMessage({
					customType: "qmd-memory",
					display: false,
					content: formatResults(results),
				}) as unknown as { catch?: (f: (e: unknown) => void) => void };
				p?.catch?.((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					if (!msg.includes("stale")) {
						console.warn("[qmd-memory] late persist failed:", msg);
					}
					rollback(msg);
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("stale")) {
					console.warn("[qmd-memory] late persist threw:", msg);
				}
				rollback(msg);
			}
		});
		queryPromise.catch(() => {}); // never unhandled
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

	// Kick the query off immediately so it runs while the user types.
	pi.on("session_start", (_event, ctx) => {
		spawnExporter(); // catch sessions that ended without a clean shutdown
		sessionCtx = ctx;
		delivered = false;
		queryResults = null;
		lastInjectedTitles = "";
		if (isEnabled()) startQuery(ctx?.cwd ?? process.cwd());
	});

	// Non-blocking: inject only if the query already resolved while the user
	// typed. Never awaits — the submitted message renders instantly.
	pi.on("before_agent_start", (_event, ctx) => {
		void ctx;
		if (delivered || !isEnabled() || !queryResults?.length) return undefined;
		delivered = true;
		cacheTitles(queryResults);
		notify(`qmd memory: ${queryResults.length} hits injected`);
		return {
			message: {
				customType: "qmd-memory",
				display: false,
				content: formatResults(queryResults),
			},
		};
	});

	// Fast-typo path: on the first LLM call where the query has landed, append
	// the results to the outgoing messages (2s race, then cached — instant on
	// later calls). Non-persistent, re-applied every call: survives compaction.
	pi.on("context", async (event, ctx) => {
		if (delivered || !isEnabled() || !queryPromise) {
			debug(`context: skip (delivered=${delivered})`);
			return undefined;
		}
		const results = await Promise.race([
			queryPromise,
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), CONTEXT_RACE_MS),
			),
		]);
		if (delivered || !results?.length || !isEnabled()) {
			debug(`context: race lost or empty (${results?.length ?? "null"})`);
			return undefined;
		}
		delivered = true;
		cacheTitles(results);
		notify(`qmd memory: ${results.length} hits injected`);
		debug(`context: appending ${results.length} hits`);
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "qmd-memory",
					content: formatResults(results),
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