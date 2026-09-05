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
const COLLECTIONS = ["wiki", "sessions"];
const LIMIT = 3;
const TIMEOUT_MS = 30_000;
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
	pi.on("session_start", (_event, ctx) => {
		spawnExporter(); // catch sessions that ended without a clean shutdown
		if (!isEnabled()) return;

		const cwd = ctx?.cwd ?? process.cwd();
		const project = basename(cwd);

		void (async () => {
			try {
				const data = await qmdQuery({
					intent: `background context for a work session in ${cwd}`,
					searches: [
						{
							type: "vec",
							query: `${project} project decisions, status, and lessons learned`,
						},
						{ type: "lex", query: project },
					],
					collections: COLLECTIONS,
					limit: LIMIT,
					rerank: true,
				});
				if (!data?.results?.length || !isEnabled()) return;

				const hits = data.results
					.map((r, i) => {
						const snippet = (r.snippet ?? "").replace(/\s+/g, " ").trim();
						const ctxLine = r.context ? `\n   context: ${r.context}` : "";
						return `${i + 1}. **${r.title ?? r.file}** — ${r.file} (${Math.round(r.score * 100)}%)${ctxLine}\n   ${snippet.slice(0, 300)}`;
					})
					.join("\n\n");

				await pi.sendMessage({
					customType: "qmd-memory",
					display: false,
					content:
						`## Retrieved context (qmd memory)\n\n` +
						`Top hits from Eric's wiki and past sessions for "${project}":\n\n${hits}\n\n` +
						`Search more with: qmd query "..." (all) · qmd search "..." -c wiki · qmd search "..." -c sessions`,
				});
			} catch (err) {
				console.warn(
					"[qmd-memory] context injection failed:",
					err instanceof Error ? err.message : err,
				);
			}
		})();
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