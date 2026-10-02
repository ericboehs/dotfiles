/**
 * Minimal subagent tool — DIY subprocess version.
 *
 * Boot cost: near zero.
 * - Single file, no top-level imports besides types (factory only calls
 *   pi.registerTool, no fs/process access, nothing awaited at startup).
 * - `exposure: "deferred"`: the tool is NOT declared to the model at boot,
 *   costs ~0 tokens until the model finds it via `tool_search`
 *   (activated automatically on session_start; no settings needed).
 * - One tiny renderCall (single Text line). No Markdown/container machinery.
 * - All heavy imports (child_process, fs, agent discovery) are lazy,
 *   inside execute(), so they never touch startup time.
 *
 * Runtime: spawns an isolated `pi --mode json -p --no-session` subprocess
 * per child, with the agent's system prompt via --append-system-prompt.
 * Supports single {agent, task} and parallel {tasks: [...]} (max 8, 4 at a time).
 * Agent files: <agentDir>/agents/*.md (user, always) + .pi/agents/*.md
 * (project, only with agentScope "project"/"both"). Plus zero-setup
 * built-ins: "scout" (read-only) and "worker" (general).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_TASKS = 8;
const CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024; // per-task bytes visible to the parent model
const BG_WAKE_CHARS = 24 * 1024; // background: log tail carried by bg.ts's completion wake

// Background progress filter (run with `node -e`): child JSONL in, one line per
// turn out, then a result banner and the final answer. Exit 1 when there is no
// answer, so bg.ts reports the job as failed.
const PROGRESS_FILTER = `
let buf = "", turns = 0, final = "";
const u = { input: 0, cached: 0, output: 0, cost: 0 };
const short = (s, n) => { s = String(s ?? "").replace(/\\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const onLine = (line) => {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  const m = ev.type === "message_end" ? ev.message : undefined;
  if (!m || m.role !== "assistant") return;
  turns++;
  const mu = m.usage ?? {};
  u.input += (mu.input ?? 0) + (mu.cacheRead ?? 0) + (mu.cacheWrite ?? 0); u.cached += mu.cacheRead ?? 0;
  u.output += mu.output ?? 0; u.cost += mu.cost?.total ?? 0;
  const calls = []; let text = "";
  for (const p of m.content ?? []) {
    if (p.type === "text" && p.text) { text = p.text; final = p.text; }
    if (p.type === "toolCall") { const a = p.arguments ?? {}; calls.push(p.name + " " + (a.command ?? a.path ?? a.pattern ?? a.url ?? "")); }
  }
  console.log("· turn " + turns + " · " + (short(calls.join(" | "), 110) || short(text, 110) || "(no text)"));
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; const ls = buf.split("\\n"); buf = ls.pop(); for (const l of ls) if (l.trim()) onLine(l); });
process.stdin.on("end", () => {
  if (buf.trim()) onLine(buf);
  const k = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  console.log("── result · " + turns + " turns · " + k(u.input) + " in (" + k(u.cached) + " cached) / " + k(u.output) + " out" + (u.cost ? " · $" + u.cost.toFixed(4) : "") + " ──");
  console.log(final || "(no output)");
  process.exitCode = final ? 0 : 1;
});
`;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name (scout, worker, or an agents/*.md file)" }),
	task: Type.String({ description: "Bounded task with concrete deliverable" }),
	cwd: Type.Optional(Type.String({ description: "Override working directory" })),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent for single mode" })),
	task: Type.Optional(Type.String({ description: "Task for single mode" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (max 8)" })),
	cwd: Type.Optional(Type.String({ description: "Working dir override (single mode)" })),
	model: Type.Optional(Type.String({ description: "Child model override, e.g. haiku" })),
	background: Type.Optional(
		Type.Boolean({ description: "Run detached via bg.ts; returns at once, result arrives as a message when done" }),
	),
	agentScope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
			description: "Agent dirs to search. Default user.",
		}),
	),
});

// Children read the same AGENTS.md as the parent, which is written for a human
// reader ("end every reply with Next steps:"). A child's reader is the parent
// agent, so every child gets this ahead of its agent prompt.
const CHILD_PREAMBLE =
	"You are a subagent. Your final message goes to another AI agent, not a human. Return only the deliverable. Ignore any instruction to add a Next steps block, follow-up suggestions, sign-offs, or questions for the user.";
const systemPrompt = (agentPrompt: string) => [CHILD_PREAMBLE, agentPrompt.trim()].filter(Boolean).join("\n\n");

// Child token/cost totals, convertible to pi's Usage (turns go in details).
type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};
type Tally = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	turns: number;
};
const newTally = (): Tally => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	turns: 0,
});
const addUsage = (t: Tally, u: UsageLike | undefined) => {
	if (!u) return;
	t.input += u.input ?? 0;
	t.output += u.output ?? 0;
	t.cacheRead += u.cacheRead ?? 0;
	t.cacheWrite += u.cacheWrite ?? 0;
	t.cost.input += u.cost?.input ?? 0;
	t.cost.output += u.cost?.output ?? 0;
	t.cost.cacheRead += u.cost?.cacheRead ?? 0;
	t.cost.cacheWrite += u.cost?.cacheWrite ?? 0;
	t.cost.total += u.cost?.total ?? 0;
};

// Zero-setup fallback agents so the tool works before any agents/*.md exist.
const BUILTINS: Record<string, { tools: string; prompt: string }> = {
	scout: {
		tools: "read,grep,find,ls,bash",
		prompt:
			"You are a read-only recon scout. Never edit files. Return: objective, relevant files with line refs, entry points, risks, where to start. Keep it under 40 lines.",
	},
	worker: {
		tools: "read,bash,edit,write,grep,find,ls",
		prompt:
			"You are a general worker. Make the requested change, verify it (build/test/lint as appropriate), and report files changed + verification output. Keep it concise.",
	},
};

export default function (pi: ExtensionAPI) {
	// Self-contained discovery: a deferred tool is unreachable unless tool_search
	// is active, so turn it on (one small declaration). Skipped in child
	// subagents, which keeps them lean and prevents recursive delegation.
	pi.on("session_start", () => {
		if (process.env.PI_SUBAGENT_CHILD) return;
		const active = pi.getActiveTools();
		if (active.includes("tool_search")) return;
		if (!pi.getAllTools().some((t) => t.name === "tool_search")) return; // e.g. excluded by --tools
		pi.setActiveTools([...active, "tool_search"]);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		exposure: "deferred", // <-- the whole trick: 0 boot tokens until tool_search finds it
		description:
			"Delegate to an isolated fresh-context pi subagent (subprocess). Single {agent, task} or parallel {tasks}. Use for recon, plans, independent review, parallel exploration. scout=read-only, worker=edits.",
		parameters: Params,

		renderCall(args, theme) {
			const summary = args.tasks?.length
				? `${args.tasks.length} tasks: ${args.tasks.slice(0, 3).map((t) => t.agent).join(", ")}${args.tasks.length > 3 ? ", …" : ""}`
				: `${args.agent ?? "?"}: ${(args.task ?? "").slice(0, 60)}`;
			return new Text(theme.fg("accent", "subagent ") + theme.fg("muted", summary), 0, 0);
		},

		async execute(_id, params, signal, onUpdate, ctx) {
			const { spawn } = await import("node:child_process");
			const fs = await import("node:fs");
			const os = await import("node:os");
			const path = await import("node:path");
			const sdk = await import("@earendil-works/pi-coding-agent");
			const getAgentDir = sdk.getAgentDir as () => string;
			const parseFrontmatter = sdk.parseFrontmatter as <T>(c: string) => { frontmatter: T; body: string };
			const CONFIG = (sdk.CONFIG_DIR_NAME as string | undefined) ?? ".pi";

			type Agent = { name: string; tools?: string; model?: string; prompt: string };
			const loadDir = (dir: string): Agent[] => {
				let entries: import("node:fs").Dirent[];
				try {
					entries = fs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return [];
				}
				const out: Agent[] = [];
				for (const e of entries) {
					if (!e.name.endsWith(".md") || (!e.isFile() && !e.isSymbolicLink())) continue;
					let content: string;
					try {
						content = fs.readFileSync(path.join(dir, e.name), "utf-8");
					} catch {
						continue;
					}
					try {
						const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
						if (typeof frontmatter.name !== "string") continue;
						const tools =
							typeof frontmatter.tools === "string"
								? frontmatter.tools
								: Array.isArray(frontmatter.tools)
									? (frontmatter.tools as unknown[]).filter((t): t is string => typeof t === "string").join(",")
									: undefined;
						out.push({
							name: frontmatter.name,
							tools,
							model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
							prompt: body,
						});
					} catch {
						/* skip bad file */
					}
				}
				return out;
			};

			const scope = params.agentScope ?? "user";
			const byName = new Map<string, Agent>();
			if (scope !== "project") for (const a of loadDir(path.join(getAgentDir(), "agents"))) byName.set(a.name, a);
			if (scope !== "user") {
				let dir: string | null = null;
				let cur = ctx.cwd;
				for (;;) {
					const cand = path.join(cur, CONFIG, "agents");
					try {
						if (fs.statSync(cand).isDirectory()) {
							dir = cand;
							break;
						}
					} catch {
						/* keep walking */
					}
					const parent = path.dirname(cur);
					if (parent === cur) break;
					cur = parent;
				}
				if (dir) for (const a of loadDir(dir)) byName.set(a.name, a);
			}
			for (const [name, b] of Object.entries(BUILTINS)) if (!byName.has(name)) byName.set(name, { name, ...b });

			const single = params.agent && params.task ? [{ agent: params.agent, task: params.task, cwd: params.cwd }] : [];
			const jobs = (params.tasks ?? single) as { agent: string; task: string; cwd?: string }[];
			if (jobs.length === 0 || jobs.length > MAX_TASKS || (params.tasks && params.agent)) {
				return {
					content: [{ type: "text" as const, text: `Pass single {agent, task} or {tasks: [...]} (1-${MAX_TASKS}). Agents: ${[...byName.keys()].join(", ") || "none"}.` }],
					details: { results: [] },
				};
			}

			const defaultModel = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

			const piInvocation = (args: string[]) => {
				const currentScript = process.argv[1];
				return currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)
					? { cmd: process.execPath, args: [currentScript, ...args] }
					: { cmd: "pi", args };
			};

			// Background: hand each child to bg.ts as a shell job (its widget, /bg live
			// log, kill, and completion wake). The progress filter turns the child's
			// JSONL into one line per turn plus the final answer, so the log is
			// readable live and the wake tail ends with the actual result.
			if (params.background) {
				const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
				const lines: string[] = [];
				for (const job of jobs) {
					const agent = byName.get(job.agent);
					if (!agent) {
						lines.push(`[${job.agent}] unknown agent. Available: ${[...byName.keys()].join(", ")}.`);
						continue;
					}
					const args = ["--mode", "json", "-p", "--no-session"];
					const model = agent.model ?? defaultModel;
					if (model) args.push("--model", model);
					if (agent.tools) args.push("--tools", agent.tools);
					args.push("--append-system-prompt", systemPrompt(agent.prompt)); // accepts text or path
					args.push(`Task: ${job.task}`);
					const inv = piInvocation(args);
					const command = `PI_SUBAGENT_CHILD=1 ${[inv.cmd, ...inv.args].map(q).join(" ")} | ${q(process.execPath)} -e ${q(PROGRESS_FILTER)}`;
					const reply = await new Promise<{ id: string; logPath: string } | { error: string } | null>((resolve) => {
						const req = {
							command,
							cwd: job.cwd ?? ctx.cwd,
							ctx,
							name: `sa:${job.agent}`,
							summary: `subagent ${job.agent}: ${job.task}`,
							tailLines: 1000,
							tailMaxChars: BG_WAKE_CHARS,
							accepted: false,
							reply: resolve,
						};
						pi.events.emit("bg:start", req);
						if (!req.accepted) resolve(null); // no listener: bg.ts not loaded
					});
					if (reply === null) {
						return {
							content: [{ type: "text" as const, text: "background needs the bg.ts extension, which is not loaded. Rerun without background." }],
							details: { results: [] },
						};
					}
					lines.push("error" in reply ? `[${job.agent}] failed: ${reply.error}` : `[${job.agent}] bg ${reply.id} · log ${reply.logPath}`);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Started in background:\n${lines.join("\n")}\nEach result arrives as a message when its child finishes. /bg watches or stops them.`,
						},
					],
					details: { results: [], background: true },
				};
			}

			// Live progress for the TUI + `tool_execution_update` JSONL events. Child
			// message_end events arrive per turn (not per token), so emitting here
			// is naturally low-volume — no throttling needed.
			type JobStatus = { agent: string; turns: number; preview: string };
			const status: JobStatus[] = jobs.map((j) => ({ agent: j.agent, turns: 0, preview: "starting…" }));
			let completed = 0;
			const previewOf = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
			const emit = () => {
				if (!onUpdate) return;
				const lines = status.map((s) => `▶ ${s.agent} · turn ${s.turns}\n${previewOf(s.preview)}`);
				onUpdate({
					content: [{ type: "text" as const, text: `subagent ${completed}/${jobs.length} done\n\n${lines.join("\n\n")}` }],
					details: { running: true, done: completed, total: jobs.length },
				});
			};

			const runOne = async (job: { agent: string; task: string; cwd?: string }, index: number) => {
				const agent = byName.get(job.agent);
				if (!agent) return { agent: job.agent, task: job.task, ok: false as const, output: `Unknown agent "${job.agent}". Available: ${[...byName.keys()].join(", ")}.` };
				const args = ["--mode", "json", "-p", "--no-session"];
				const model = agent.model ?? defaultModel;
				if (model) args.push("--model", model);
				if (agent.tools) args.push("--tools", agent.tools);
				const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
				const tmpFile = path.join(tmpDir, "system.md");
				await fs.promises.writeFile(tmpFile, systemPrompt(agent.prompt), { mode: 0o600 });
				args.push("--append-system-prompt", tmpFile);
				args.push(`Task: ${job.task}`);
				const invocation = piInvocation(args);
				try {
					const usage = newTally();
					let final = "";
					const stderr: string[] = [];
					const exitCode: number = await new Promise((resolve) => {
						const proc = spawn(invocation.cmd, invocation.args, { cwd: job.cwd ?? ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SUBAGENT_CHILD: "1" } });
						let buf = "";
						const onLine = (line: string) => {
							if (!line.trim()) return;
							let ev: { type?: string; message?: { role?: string; content?: { type: string; text?: string }[]; usage?: UsageLike } };
							try {
								ev = JSON.parse(line);
							} catch {
								return;
							}
							const m = ev.type === "message_end" ? ev.message : undefined;
							if (m?.role === "assistant") {
								usage.turns++;
								addUsage(usage, m.usage);
								for (const p of m.content ?? []) if (p.type === "text" && p.text) final = p.text;
								status[index] = { agent: job.agent, turns: usage.turns, preview: final || "(working…)" };
								emit();
							}
						};
						proc.stdout.on("data", (d) => {
							buf += d.toString();
							const lines = buf.split("\n");
							buf = lines.pop() ?? "";
							for (const l of lines) onLine(l);
						});
						proc.stderr.on("data", (d) => stderr.push(d.toString()));
						proc.on("close", (c) => {
							if (buf.trim()) onLine(buf);
							resolve(c ?? 0);
						});
						proc.on("error", () => resolve(1));
						if (signal) {
							if (signal.aborted) proc.kill("SIGTERM");
							else signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
						}
					});
					if (exitCode !== 0 && !final) return { agent: job.agent, task: job.task, ok: false as const, output: stderr.join("").slice(-2000) || `exit ${exitCode}`, usage };
					let out = final || "(no output)";
					if (Buffer.byteLength(out) > OUTPUT_CAP) out += `\n\n[${Buffer.byteLength(out) - OUTPUT_CAP} bytes over cap omitted]`;
					return { agent: job.agent, task: job.task, ok: true as const, output: out.slice(0, OUTPUT_CAP + 200), usage };
				} finally {
					fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
				}
			};

			// concurrency-limited parallel
			const results: Awaited<ReturnType<typeof runOne>>[] = new Array(jobs.length);
			let next = 0;
			emit(); // show "starting…" immediately so live watchers see the launch
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
					for (;;) {
						const i = next++;
						const job = jobs[i];
						if (!job) return;
						results[i] = await runOne(job, i);
						completed++;
						emit();
					}
				}),
			);

			const okCount = results.filter((r) => r.ok).length;
			const text =
				results.length === 1
					? (results[0]?.output ?? "(no output)")
					: `${okCount}/${results.length} succeeded\n\n` +
						results.map((r) => `### [${r.agent}] ${r.ok ? "ok" : "FAILED"}\n\n${r.output}`).join("\n\n---\n\n");
			const total = newTally();
			for (const r of results) {
				if (!("usage" in r) || !r.usage) continue;
				addUsage(total, r.usage);
				total.turns += r.usage.turns;
			}
			const { turns, ...tokens } = total;
			return {
				content: [{ type: "text" as const, text }],
				details: { results: results.map((r) => ({ agent: r.agent, ok: r.ok })), turns },
				...(turns > 0
					? { usage: { ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite } }
					: {}),
			};
		},
	});
}
