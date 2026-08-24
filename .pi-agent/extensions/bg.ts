/**
 * bg.ts — background task runner for pi
 *
 * Design goals: minimal permanent context cost, minimal boot cost.
 *
 *   Context: +33 tokens total. Adds one optional `background` boolean to the
 *            existing built-in `bash` tool instead of registering bg_start /
 *            bg_status / bg_logs / bg_wait / bg_kill. Status and logs need no
 *            tools — the log is a plain file the model reads with `read`.
 *   Boot:    ~20ms. Single file, no npm dependencies. Nothing is started at
 *            factory time; all resources come up in session_start.
 *
 * UI:
 *   footer          "● 2 bg · rspec 1m12s · vite 12s"   (zero tokens, TUI only)
 *   /bg             job list; ↑/↓ select, enter opens a full-screen live log,
 *                   x stops the selected job, esc closes
 *   ctrl+shift+b    same panel
 *
 *   ctrl+shift+b only reaches pi where the terminal disambiguates it via the
 *   Kitty/CSI-u protocol (tmux: `extended-keys on` + `extended-keys-format
 *   csi-u`). Without that it collapses to 0x02, i.e. plain ctrl+b — swallowed
 *   as the tmux prefix, or read as tui.editor.cursorLeft outside tmux. The
 *   failure mode is a dead shortcut, never a false trigger, so /bg is the
 *   portable path and the one to reach for on an unfamiliar host.
 *
 * Wake:
 *   When a job exits, injects exit code + tail into the conversation and
 *   triggers a turn. User-initiated kills never wake the model.
 *
 * Env knobs:
 *   PI_BG_DIR         log/spool directory (default /tmp/pi-bg-<uid>, mode
 *                     0700; not $TMPDIR — macOS makes that per-user and
 *                     unguessable, and purges it out from under running jobs)
 *   PI_BG_TAIL_LINES  lines injected on completion (default 15, 0 disables)
 *   PI_BG_WAKE        followUp | nextTurn | off  (default followUp)
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Deliberately NOT os.tmpdir(): on macOS that is /var/folders/<hash>/T, which is
// unguessable for a path we hand to the model, and macOS purges it periodically —
// which would delete the logs of exactly the long-running jobs this exists for.
// Suffixed with the uid so two users on one box cannot collide on ownership of
// a shared /tmp/pi-bg directory.
function defaultBgDir(): string {
	if (process.platform === "win32") return path.join(os.tmpdir(), "pi-bg");
	let uid = "";
	try {
		uid = `-${os.userInfo().uid}`;
	} catch {
		// uid unavailable; fall back to the bare path
	}
	return `/tmp/pi-bg${uid}`;
}

const BG_DIR = process.env.PI_BG_DIR ?? defaultBgDir();
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only ever delete files this extension created: exactly <6 hex>.log */
const LOG_NAME_RE = /^[0-9a-f]{6}\.log$/;
const TAIL_LINES = Number.parseInt(process.env.PI_BG_TAIL_LINES ?? "15", 10);
const TAIL_MAX_CHARS = 2000;
const VIEWER_WINDOW_BYTES = 1024 * 1024;
const WAKE = (process.env.PI_BG_WAKE ?? "followUp") as "followUp" | "nextTurn" | "off";
const STATUS_KEY = "bg";
const MAX_STATUS_JOBS = 3;

interface Job {
	id: string;
	name: string;
	command: string;
	logPath: string;
	pid: number | undefined;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	killedByUser: boolean;
}

/**
 * "bundle exec rspec spec/foo" -> "rspec". Best-effort label for the footer.
 * Skips shell keywords, wrappers, env assignments, and loop variables so that
 * e.g. `for i in $(seq 1 400); do echo ...` labels as "echo", not "for".
 */
const LABEL_SKIP = new Set([
	// shell control keywords
	"for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "in", "case", "esac",
	// wrappers and runners that say nothing about the job
	"sudo", "env", "time", "nohup", "exec", "command", "bundle", "npm", "npx", "pnpm", "yarn",
	"run", "bin/rails", "rails", "mise", "asdf", "uv", "poetry", "bunx", "deno", "task", "just",
]);

function labelFor(command: string): string {
	const words = command.trim().split(/\s+/);
	for (const word of words) {
		if (word.length < 2) continue; // loop vars like `i`
		if (word.includes("=")) continue; // FOO=bar prefixes
		if (!/^[A-Za-z0-9_.:/-]+$/.test(word)) continue; // $(seq, quotes, redirects
		if (/^\d+$/.test(word)) continue; // bare numbers
		if (LABEL_SKIP.has(word)) continue;
		return path.basename(word).slice(0, 14);
	}
	// Nothing looked like a program name; fall back to the first token that is
	// at least not an environment assignment.
	return words.find((word) => !word.includes("="))?.slice(0, 14) ?? "job";
}

function humanDuration(ms: number): string {
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Read the last `count` lines without slurping a huge log into memory. */
function tailFile(
	logPath: string,
	count: number,
	windowBytes = 256 * 1024,
): { text: string; lines: number; shown: number } {
	const all = tailLines(logPath, windowBytes);
	let selected = count > 0 ? all.slice(-count) : [];
	// Drop whole lines from the front until it fits, so the tail never begins
	// mid-line; only fall back to a hard character cut for a single huge line.
	while (selected.length > 1 && selected.join("\n").length > TAIL_MAX_CHARS) {
		selected = selected.slice(1);
	}
	let text = selected.join("\n");
	if (text.length > TAIL_MAX_CHARS) text = `…${text.slice(-TAIL_MAX_CHARS)}`;
	return { text, lines: all.length, shown: selected.length };
}

/** Read the tail of a file as lines, bounded by a byte window. */
function tailLines(logPath: string, windowBytes: number): string[] {
	let raw: string;
	try {
		const size = fs.statSync(logPath).size;
		const window = Math.min(size, windowBytes);
		const buffer = Buffer.alloc(window);
		const fd = fs.openSync(logPath, "r");
		try {
			fs.readSync(fd, buffer, 0, window, size - window);
		} finally {
			fs.closeSync(fd);
		}
		raw = buffer.toString("utf8");
	} catch {
		return [];
	}
	const all = raw.split("\n");
	if (all.at(-1) === "") all.pop();
	return all;
}

interface PanelDeps {
	tui: { requestRender(): void; terminal?: { rows: number } };
	theme: { fg(color: string, text: string): string };
	getJobs: () => Job[];
	kill: (job: Job) => boolean;
	done: () => void;
}

/** Short status suffix shown in the job list, e.g. "running 1m02s". */
function statusOf(job: Job): string {
	const elapsed = humanDuration((job.endedAt ?? Date.now()) - job.startedAt);
	if (job.endedAt === undefined) return `running ${elapsed}`;
	if (job.signal) return `stopped ${elapsed}`;
	if (job.exitCode === 0) return `done ${elapsed}`;
	return `exit ${job.exitCode} · ${elapsed}`;
}

/**
 * Background job panel: a list view and a full-screen detail view.
 *
 * Deliberately not ctx.ui.select()/ctx.ui.editor(): select() would force a
 * submenu just to stop a job, and editor() is an editable prompt advertising
 * "enter submit", which is wrong for a log. Renders in the TUI only, so
 * viewing a 10k-line log costs zero tokens.
 */
class BgPanel {
	private mode: "list" | "detail" = "list";
	/**
	 * Selection is tracked by job id, never by list index: jobList() re-sorts
	 * running-first, so stopping a job reorders the list and an index would
	 * silently slide onto a different job — and then `x` would kill the wrong one.
	 */
	private selectedId: string | undefined;
	private lines: string[] = [];
	private scroll = 0;
	private follow = true;
	private timer: NodeJS.Timeout | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	/** Extra rows consumed by a wrapped Command: line, fed back into sizing. */
	private commandExtraRows = 0;

	constructor(private readonly deps: PanelDeps) {
		// Runtime counters tick and logs grow while the panel is open.
		this.timer = setInterval(() => {
			if (this.mode === "detail") this.load();
			this.invalidate();
			this.deps.tui.requestRender();
		}, 1000);
		this.timer.unref?.();
	}

	private jobList(): Job[] {
		// Running first, then most recently started.
		return this.deps.getJobs().sort((a, b) => {
			const aDone = a.endedAt === undefined ? 0 : 1;
			const bDone = b.endedAt === undefined ? 0 : 1;
			return aDone - bDone || b.startedAt - a.startedAt;
		});
	}

	private current(): Job | undefined {
		const jobs = this.jobList();
		return jobs.find((job) => job.id === this.selectedId) ?? jobs[0];
	}

	/** Move the selection by `delta` rows, resolving through ids. */
	private move(delta: number): void {
		const jobs = this.jobList();
		if (jobs.length === 0) return;
		const index = Math.max(
			0,
			jobs.findIndex((job) => job.id === this.selectedId),
		);
		const next = Math.max(0, Math.min(jobs.length - 1, index + delta));
		this.selectedId = jobs[next]?.id;
		this.invalidate();
	}

	private load(): void {
		const job = this.current();
		if (!job) return;
		this.lines = tailLines(job.logPath, VIEWER_WINDOW_BYTES);
		if (this.follow) this.scroll = this.maxScroll();
	}

	private terminalRows(): number {
		return this.deps.tui.terminal?.rows ?? process.stdout.rows ?? 24;
	}

	/**
	 * Output box height. Budget: 13 rows of panel chrome (title, status block,
	 * borders, hint) plus ~7 rows of pi's own editor/footer/status chrome that
	 * sit outside this component. Undercounting clips the hint line off-screen.
	 */
	private viewportHeight(): number {
		return Math.max(5, this.terminalRows() - 20 - this.commandExtraRows);
	}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.viewportHeight());
	}

	private scrollBy(delta: number): void {
		const next = Math.max(0, Math.min(this.maxScroll(), this.scroll + delta));
		if (next === this.scroll) return;
		this.scroll = next;
		this.follow = this.scroll >= this.maxScroll();
		this.invalidate();
	}

	private stopSelected(): void {
		const job = this.current();
		if (job && job.endedAt === undefined) this.deps.kill(job);
		this.invalidate();
	}

	private close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.deps.done();
	}

	handleInput(data: string): void {
		if (this.selectedId === undefined) this.selectedId = this.jobList()[0]?.id;

		if (this.mode === "list") {
			if (matchesKey(data, Key.up)) {
				this.move(-1);
			} else if (matchesKey(data, Key.down)) {
				this.move(1);
			} else if (matchesKey(data, Key.enter)) {
				this.mode = "detail";
				this.follow = true;
				this.scroll = 0;
				this.load();
				this.invalidate();
			} else if (data === "x") {
				this.stopSelected();
			} else if (matchesKey(data, Key.escape) || data === "q") {
				this.close();
			}
			return;
		}

		const page = this.viewportHeight() - 1;
		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-page);
		else if (matchesKey(data, "pageDown")) this.scrollBy(page);
		else if (matchesKey(data, Key.home) || data === "g") this.scrollBy(-this.lines.length);
		else if (matchesKey(data, Key.end) || data === "G") this.scrollBy(this.lines.length);
		else if (data === "x") this.stopSelected();
		else if (matchesKey(data, Key.escape)) {
			this.mode = "list";
			this.invalidate();
		} else if (data === "q") this.close();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	/** One row inside the output box, padded so the right border lines up. */
	private boxed(content: string, width: number): string {
		const inner = Math.max(1, width - 4);
		const text = truncateToWidth(content, inner);
		return `│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const out = this.mode === "list" ? this.renderList(width) : this.renderDetail(width);
		this.cachedLines = out;
		this.cachedWidth = width;
		return out;
	}

	private renderList(width: number): string[] {
		const { theme } = this.deps;
		const jobs = this.jobList();
		if (this.selectedId === undefined) this.selectedId = jobs[0]?.id;
		const active = jobs.filter((job) => job.endedAt === undefined).length;
		const finished = jobs.length - active;
		const out = [
			truncateToWidth(theme.fg("accent", "Background"), width),
			truncateToWidth(
				`${active} active job${active === 1 ? "" : "s"}${finished > 0 ? ` · ${finished} finished` : ""}`,
				width,
			),
			"",
		];

		jobs.forEach((job) => {
			const status = ` (${statusOf(job)})`;
			const room = Math.max(10, width - visibleWidth(status) - 3);
			const truncated = visibleWidth(job.command) > room;
			const command = truncateToWidth(job.command, truncated ? room - 1 : room);
			const row = `${command}${truncated ? "…" : ""}${status}`;
			out.push(
				job.id === this.selectedId
					? truncateToWidth(theme.fg("accent", `❯ ${row}`), width)
					: truncateToWidth(`  ${row}`, width),
			);
		});

		out.push("");
		out.push(
			truncateToWidth(
				theme.fg("dim", "↑/↓ to select · Enter to view · x to stop · Esc to close"),
				width,
			),
		);
		return out;
	}

	private renderDetail(width: number): string[] {
		const { theme } = this.deps;
		const job = this.current();
		if (!job) {
			this.mode = "list";
			return this.renderList(width);
		}

		const label = 10;
		const wrap = Math.max(20, width - label);
		const commandLines: string[] = [];
		for (let i = 0; i < job.command.length; i += wrap) {
			commandLines.push(job.command.slice(i, i + wrap));
		}
		this.commandExtraRows = commandLines.length - 1;

		const out = [
			truncateToWidth(theme.fg("accent", "Shell details"), width),
			"",
			truncateToWidth(`${"Status:".padEnd(label)}${statusOf(job)}`, width),
			truncateToWidth(`${"Log:".padEnd(label)}${job.logPath}`, width),
			truncateToWidth(`${"Command:".padEnd(label)}${commandLines[0] ?? ""}`, width),
			...commandLines.slice(1).map((l) => truncateToWidth(`${" ".repeat(label)}${l}`, width)),
			"",
			truncateToWidth("Output:", width),
		];

		const height = this.viewportHeight();
		const window = this.lines.slice(this.scroll, this.scroll + height);
		const inner = Math.max(1, width - 4);
		out.push(`╭${"─".repeat(inner + 2)}╮`);
		if (this.lines.length === 0) {
			out.push(this.boxed(theme.fg("dim", "(no output yet)"), width));
			for (let i = 1; i < height; i++) out.push(this.boxed("", width));
		} else {
			for (const line of window) out.push(this.boxed(line, width));
			for (let i = window.length; i < height; i++) out.push(this.boxed("", width));
		}
		out.push(`╰${"─".repeat(inner + 2)}╯`);

		const position = this.follow
			? "following"
			: `${this.scroll + 1}-${this.scroll + window.length}`;
		out.push(
			truncateToWidth(theme.fg("dim", `Showing ${this.lines.length} lines · ${position}`), width),
		);
		out.push("");
		out.push(
			truncateToWidth(
				theme.fg("dim", "↑/↓ scroll · pgup/pgdn page · g/G top/bottom · x to stop · Esc to go back"),
				width,
			),
		);
		return out;
	}
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	let ctxRef: ExtensionContext | undefined;
	let ticker: NodeJS.Timeout | undefined;

	const running = () => [...jobs.values()].filter((job) => job.endedAt === undefined);

	function renderStatus(): void {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		const active = running();
		if (active.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const now = Date.now();
		// Shell loops often collapse to the same label (three `echo` jobs are
		// indistinguishable), so fall back to the id whenever a name repeats.
		const nameCounts = new Map<string, number>();
		for (const job of active) nameCounts.set(job.name, (nameCounts.get(job.name) ?? 0) + 1);
		const shown = active
			.slice(0, MAX_STATUS_JOBS)
			.map(
				(job) =>
					`${(nameCounts.get(job.name) ?? 0) > 1 ? job.id : job.name} ${humanDuration(now - job.startedAt)}`,
			);
		if (active.length > MAX_STATUS_JOBS) shown.push(`+${active.length - MAX_STATUS_JOBS}`);
		const dot = theme.fg("accent", "●");
		const label = active.length === 1 ? "1 bg" : `${active.length} bg`;
		ctx.ui.setStatus(STATUS_KEY, `${dot} ${theme.fg("dim", `${label} · ${shown.join(" · ")}`)}`);
	}

	function syncTicker(): void {
		const active = running().length > 0;
		if (active && !ticker) {
			ticker = setInterval(renderStatus, 1000);
			ticker.unref?.();
		} else if (!active && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
		renderStatus();
	}

	async function start(command: string): Promise<Job> {
		fs.mkdirSync(BG_DIR, { recursive: true, mode: 0o700 });
		const id = crypto.randomBytes(3).toString("hex");
		const logPath = path.join(BG_DIR, `${id}.log`);
		const fd = fs.openSync(logPath, "a");

		const child = spawn(command, {
			shell: true,
			detached: true, // own process group, so we can kill the whole tree
			cwd: process.cwd(),
			stdio: ["ignore", fd, fd],
			env: { ...process.env, PI_BG_JOB_ID: id },
		});
		fs.closeSync(fd);
		child.unref();

		const job: Job = {
			id,
			name: labelFor(command),
			command,
			logPath,
			pid: child.pid,
			startedAt: Date.now(),
			killedByUser: false,
		};
		jobs.set(id, job);

		// Listeners are attached synchronously so a fast-exiting job cannot slip
		// through the gap while we await "spawn".
		const ready = new Promise<void>((resolve) => {
			child.once("spawn", () => resolve());
			child.once("exit", (code, signal) => {
				finish(job, code, signal);
				resolve();
			});
			child.once("error", (error) => {
				appendLog(job, `pi-bg: failed to start: ${error.message}`);
				finish(job, 127, null);
				resolve();
			});
		});

		syncTicker();
		// Confirm the fork actually happened before telling the model "started",
		// so spawn failures surface in the tool result instead of arriving later.
		await ready;
		return job;
	}

	/**
	 * Drop logs from long-dead jobs. Best-effort, once per session.
	 * Strictly scoped: only files matching LOG_NAME_RE, only regular files, never
	 * directories or symlinks, so a shared or user-populated BG_DIR is safe.
	 */
	function pruneLogs(): void {
		try {
			const cutoff = Date.now() - LOG_TTL_MS;
			for (const entry of fs.readdirSync(BG_DIR, { withFileTypes: true })) {
				if (!entry.isFile() || !LOG_NAME_RE.test(entry.name)) continue;
				const file = path.join(BG_DIR, entry.name);
				if (fs.lstatSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
			}
		} catch {
			// directory may not exist yet
		}
	}

	function appendLog(job: Job, line: string): void {
		try {
			fs.appendFileSync(job.logPath, `${line}\n`);
		} catch {
			// log is best-effort
		}
	}

	function finish(job: Job, code: number | null, signal: NodeJS.Signals | null): void {
		if (job.endedAt !== undefined) return;
		job.endedAt = Date.now();
		job.exitCode = code;
		job.signal = signal;
		syncTicker();

		const elapsed = humanDuration(job.endedAt - job.startedAt);
		const outcome =
			signal !== null ? `killed (${signal})` : code === 0 ? "succeeded" : `exited ${code}`;

		if (job.killedByUser || WAKE === "off") {
			ctxRef?.ui?.notify(`bg ${job.id} ${outcome} after ${elapsed}`, "info");
			return;
		}

		const { text, lines, shown } = tailFile(job.logPath, TAIL_LINES);
		const omitted = lines - shown;
		// The model saw the command when it launched the job, so replaying it in
		// full on every completion is pure token cost. Collapse whitespace too:
		// a multi-line command would otherwise mangle the header.
		const oneLine = job.command.replace(/\s+/g, " ").trim();
		const command = oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
		const header =
			`[bg ${job.id}] \`${command}\` ${outcome} after ${elapsed}\n` +
			`log: ${job.logPath} (${lines} line${lines === 1 ? "" : "s"})`;
		// Report what was actually included, not the configured cap: a capped tail
		// otherwise reads as if the job started partway through.
		const body = text
			? `\nlast ${shown} line${shown === 1 ? "" : "s"}${omitted > 0 ? ` (${omitted} earlier omitted)` : ""}:\n${text}`
			: "\n(no output)";

		pi.sendMessage(
			{ customType: "bg", content: header + body, display: true, details: { id: job.id } },
			// followUp waits for any in-flight turn to finish its tool calls;
			// triggerTurn wakes the model when idle. nextTurn parks it silently.
			WAKE === "nextTurn"
				? { deliverAs: "nextTurn" }
				: { deliverAs: "followUp", triggerTurn: true },
		);
	}

	function kill(job: Job): boolean {
		if (job.endedAt !== undefined || job.pid === undefined) return false;
		job.killedByUser = true;
		try {
			process.kill(-job.pid, "SIGTERM"); // negative pid = whole process group
			setTimeout(() => {
				if (job.endedAt === undefined && job.pid !== undefined) {
					try {
						process.kill(-job.pid, "SIGKILL");
					} catch {
						// already gone
					}
				}
			}, 5000).unref?.();
			return true;
		} catch {
			finish(job, null, "SIGTERM");
			return false;
		}
	}

	// ---- bash override: +33 tokens, the entire discovery surface -------------

	const base = createBashToolDefinition(process.cwd());
	const baseProperties = (base.parameters as unknown as { properties: Record<string, unknown> })
		.properties;

	pi.registerTool({
		...base,
		parameters: Type.Object({
			...baseProperties,
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run detached; returns a job id immediately and notifies on completion",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params as { command: string; timeout?: number; background?: boolean };
			if (!input.background) {
				return base.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			const job = await start(input.command);
			if (job.endedAt !== undefined && job.exitCode === 127) {
				return {
					content: [{ type: "text", text: `bg job failed to start; see ${job.logPath}` }],
					details: undefined,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `bg job ${job.id} started · log: ${job.logPath}`,
					},
				],
				details: undefined,
			};
		},
	} as Parameters<ExtensionAPI["registerTool"]>[0]);

	// ---- UI -----------------------------------------------------------------

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (jobs.size === 0) {
			ctx.ui.notify("No background jobs", "info");
			return;
		}
		// TUI-only: never enters the conversation, so log size costs no tokens.
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new BgPanel({
					tui: tui as unknown as PanelDeps["tui"],
					theme,
					getJobs: () => [...jobs.values()],
					kill,
					done: () => done(undefined),
				}) as never,
		);
	}

	pi.registerCommand("bg", {
		description: "List, view, or stop background jobs",
		handler: async (_args, ctx) => {
			await openPanel(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+b", {
		// Requires CSI-u disambiguation; /bg is the portable fallback.
		description: "Background jobs (also /bg)",
		handler: async (ctx) => {
			await openPanel(ctx);
		},
	});

	// ---- lifecycle ----------------------------------------------------------
	// Nothing above this point starts a resource; per the docs, background
	// resources must not be created in the factory.

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		pruneLogs();
		syncTicker();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		const orphans = running();
		if (orphans.length > 0 && ctx.hasUI) {
			// Detached jobs outlive pi on purpose; surface where to find them.
			ctx.ui.notify(
				`${orphans.length} bg job(s) still running: ${orphans.map((j) => j.id).join(", ")} in ${BG_DIR}`,
				"warning",
			);
		}
		ctxRef = undefined;
	});
}
