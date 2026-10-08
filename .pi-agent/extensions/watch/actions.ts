/**
 * watch/actions.ts — acting on the watch list: the picker (ctrl+shift+w or a
 * bare /watch), bursts, links, snooze times. Pure but for the picker panel,
 * which only draws and reads keys; watch.ts does each verb. Not an extension:
 * pi loads only top-level files and folders with an index.ts.
 *
 *   bursts   items from one person in one conversation, each within 10 minutes
 *            of another, are one row: in the widget, the picker and /watch clear N.
 *   links    a Slack item links to its message; any item that names a
 *            ServiceNow ticket (RITM…, INC…) links to it when PI_WATCH_SNOW_URL
 *            is set. "Open" shows an OSC 8 link and copies it (pi's
 *            copyToClipboard: OSC 52 over SSH): pi runs over SSH, so `open`
 *            would use the wrong Mac.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Verb = "open" | "ask" | "done" | "snooze" | "mute" | "wait" | "undo";
export const BURST_S = 10 * 60;

/** The item fields this file reads. */
export type RowItem = {
	key: string;
	ts: string;
	from: string;
	workspace: string;
	channel: string;
	threadTs?: string;
	text: string;
	closesWait?: string;
	maybeWait?: string;
	offer?: string;
	snoozeUntil?: string;
};
export type Row<T extends RowItem> = { lead: T; items: T[] };

const isNotif = (i: Pick<RowItem, "key">) => i.key.startsWith("notif:");
/** One conversation with one person: a text's "channel" is its app, so the sender makes it one. */
export const convoKey = (i: RowItem) =>
	isNotif(i) ? `n|${i.channel}|${i.from.toLowerCase()}` : `${i.workspace}|${i.channel}|${i.threadTs ?? ""}|${i.from.toLowerCase()}`;

/**
 * Rows in the order given (needsList: best first). An item joins a row of the
 * same conversation when it is within windowS of an item in it. A wait reply
 * or a maybe stays on its own row: it has its own mark.
 */
export function bursts<T extends RowItem>(needs: readonly T[], windowS = BURST_S): Row<T>[] {
	const rows: Row<T>[] = [];
	for (const i of needs) {
		const solo = !!(i.closesWait || i.maybeWait);
		const k = convoKey(i);
		const t = Number(i.ts);
		const row = solo
			? undefined
			: rows.find((r) => !r.lead.closesWait && !r.lead.maybeWait && convoKey(r.lead) === k && r.items.some((x) => Math.abs(Number(x.ts) - t) <= windowS));
		if (row) row.items.push(i);
		else rows.push({ lead: i, items: [i] });
	}
	return rows;
}

/** Hidden from the widget, the picker and the acts until then; a read still clears it. */
export const isSnoozed = (i: Pick<RowItem, "snoozeUntil">, now = Date.now()) => !!i.snoozeUntil && Date.parse(i.snoozeUntil) > now;

// ── links ────────────────────────────────────────────────────────────────────

export const TICKET = /\b(?:RITM|INC|SCTASK|REQ|CHG|PRB)\d{7}\b/;

export const slackLink = (workspace: string, channel: string, ts: string, threadTs?: string) =>
	`https://${workspace}.slack.com/archives/${channel}/p${ts.replace(".", "")}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""}`;

/** Where the item lives, with a label, or undefined: a text or Outlook preview has no place to go. */
export function linkOf(i: RowItem, snowBase = ""): { url: string; label: string } | undefined {
	if (!isNotif(i) && /^[CDG][A-Z0-9]+$/.test(i.channel)) return { url: slackLink(i.workspace, i.channel, i.ts, i.threadTs), label: "Slack message" };
	const t = TICKET.exec(i.text)?.[0];
	if (t && snowBase) return { url: `${snowBase.replace(/\/+$/, "")}/nav_to.do?uri=${encodeURIComponent(`task.do?sysparm_query=number=${t}`)}`, label: t };
	return undefined;
}

/** What Enter does: the scout's offer, else the link, else done. */
export const defaultVerb = (i: RowItem, hasLink: boolean): Verb => (i.offer ? "ask" : hasLink ? "open" : "done");

/** A terminal link: a click opens it on the computer the terminal runs on. */
export const osc8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

// ── snooze ───────────────────────────────────────────────────────────────────

export const SNOOZES = ["1 hour", "3 hours", "tomorrow 8 AM", "Monday 8 AM"] as const;

/** When a snooze choice ends. "Monday" on a Monday is next week's. */
export function snoozeEnd(choice: string, now = new Date()): Date | undefined {
	const c = choice.toLowerCase().trim();
	const h = /^(\d+)\s*(?:h|hours?)$/.exec(c);
	if (h) return new Date(now.getTime() + Number(h[1]) * 3600_000);
	const at8 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 0, 0, 0);
	if (/^tomorrow/.test(c)) return at8(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
	if (/^monday/.test(c)) {
		const days = ((8 - now.getDay()) % 7) || 7;
		return at8(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
	}
	return undefined;
}

// ── mute ─────────────────────────────────────────────────────────────────────

export type MuteSpec = { from?: string; text?: string; app?: string; until?: string };
const word = (s: string, key: string) => new RegExp(`\\b${key}\\s+(?:"([^"]+)"|(\\S+))`, "i").exec(s);
const val = (m: RegExpExecArray | null) => (m ? (m[1] ?? m[2])!.trim() : undefined);

/** `from "Name" [in App] [for 7d]`, `text "phrase" [in App] [for 12h]`. Needs from or text. */
export function parseMuteArgs(rest: string, now = Date.now(), iso: (d: Date) => string = (d) => d.toISOString()): MuteSpec | null {
	const from = val(word(rest, "from"));
	const text = val(word(rest, "text"));
	if (!from && !text) return null;
	const app = val(word(rest, "in"));
	const f = /\bfor\s+(\d+)\s*([dh])\b/i.exec(rest);
	const until = f ? iso(new Date(now + Number(f[1]) * (f[2]!.toLowerCase() === "d" ? 86_400_000 : 3_600_000))) : undefined;
	return { ...(from ? { from } : {}), ...(text ? { text } : {}), ...(app ? { app } : {}), ...(until ? { until } : {}) };
}

/** The mark before an item: ✓ wait reply, ? maybe, ! bot feed ask, @ mention, ✉ DM, ◇ notification, ↳ thread. */
export function iconOf(i: { closesWait?: string; maybeWait?: string; kind: string }): { ch: string; color: "success" | "warning" | "accent" } {
	if (i.closesWait) return { ch: "✓", color: "success" };
	if (i.maybeWait) return { ch: "?", color: "warning" };
	if (i.kind === "feed-ask") return { ch: "!", color: "warning" };
	if (i.kind === "mention" || i.kind === "broadcast") return { ch: "@", color: "accent" };
	if (i.kind === "dm" || i.kind === "group") return { ch: "✉", color: "accent" };
	if (i.kind === "call") return { ch: "◇", color: "warning" };
	if (i.kind === "text" || i.kind === "work" || i.kind === "event") return { ch: "◇", color: "accent" };
	return { ch: "↳", color: "accent" };
}

// ── the picker ───────────────────────────────────────────────────────────────

export type PickerRow = { icon: string; label: string; age: string; count: number; verb: Verb };
export type WaitVerb = "close" | "drop" | "reopen";
/** A row verb on needs row `row`, or a wait verb on wait `row` (zone "waits"). */
export type PickerResult = { verb: Verb; row: number; zone?: "rows" | "waits" } | { verb: WaitVerb; row: number; zone: "waits" };
export const isWaitVerb = (v: string): v is WaitVerb => v === "close" || v === "drop" || v === "reopen";
/** One line under "Waiting on": open (maybe answered or not) or closed in the last day. */
export type PickerWait = { line: string; state: "open" | "maybe" | "closed" };
type Deps = {
	tui: { requestRender(): void };
	theme: { fg(color: string, text: string): string };
	title: string;
	rows: PickerRow[];
	selected: number;
	flash: string; // the last result, shown under the list (may hold an OSC 8 link)
	canUndo: boolean;
	waits?: PickerWait[]; // under the rows ("W1 Dana Ruiz · the RITM status 2h"); Tab moves there
	zone?: "rows" | "waits"; // where the selection starts
	done: (r: PickerResult | undefined) => void;
};

const KEY_VERB: Record<string, Verb> = { o: "open", a: "ask", d: "done", s: "snooze", m: "mute", w: "wait" };
const VERB_WORD: Record<Verb, string> = { open: "open", ask: "ask agent", done: "done", snooze: "snooze", mute: "mute", wait: "wait", undo: "undo" };
const KEY_WAIT: Record<string, WaitVerb> = { c: "close", x: "drop", r: "reopen" };
/** What c, x, r and Enter can do to a wait in each state. */
const WAIT_CAN: Record<PickerWait["state"], WaitVerb[]> = { open: ["close", "drop"], maybe: ["close", "drop"], closed: ["reopen", "drop"] };

/** The list: ↑↓ or j/k to move, a key for each verb, Enter for the row's default; Tab to the waits and back. */
export class PickerPanel {
	private readonly d: Deps;
	private sel: number;
	private zone: "rows" | "waits";

	constructor(d: Deps) {
		this.d = d;
		const waits = d.waits ?? [];
		this.zone = (d.zone === "waits" && waits.length) || (!d.rows.length && waits.length) ? "waits" : "rows";
		this.sel = Math.max(0, Math.min(d.selected, (this.zone === "waits" ? waits.length : d.rows.length) - 1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") return this.d.done(undefined);
		if (data === "u" && this.d.canUndo) return this.d.done({ verb: "undo", row: this.sel, zone: this.zone });
		const waits = this.d.waits ?? [];
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const other = this.zone === "rows" ? waits.length : this.d.rows.length;
			if (other) {
				this.zone = this.zone === "rows" ? "waits" : "rows";
				this.sel = 0;
				this.d.tui.requestRender();
			}
			return;
		}
		if (this.zone === "waits") return this.waitInput(data, waits);
		const n = this.d.rows.length;
		if (!n) return;
		if (matchesKey(data, "up") || data === "k") this.sel = (this.sel - 1 + n) % n;
		else if (matchesKey(data, "down") || data === "j") this.sel = (this.sel + 1) % n;
		else if (matchesKey(data, "enter")) return this.d.done({ verb: this.d.rows[this.sel]!.verb, row: this.sel });
		else if (/^[1-9]$/.test(data) && Number(data) <= n) this.sel = Number(data) - 1;
		else if (KEY_VERB[data]) return this.d.done({ verb: KEY_VERB[data]!, row: this.sel });
		this.d.tui.requestRender();
	}

	private waitInput(data: string, waits: PickerWait[]): void {
		const n = waits.length;
		const cur = waits[this.sel];
		if (!cur) return;
		if (matchesKey(data, "up") || data === "k") this.sel = (this.sel - 1 + n) % n;
		else if (matchesKey(data, "down") || data === "j") this.sel = (this.sel + 1) % n;
		else if (matchesKey(data, "enter")) return this.d.done({ verb: WAIT_CAN[cur.state][0]!, row: this.sel, zone: "waits" });
		else if (KEY_WAIT[data]) {
			if (WAIT_CAN[cur.state].includes(KEY_WAIT[data]!)) return this.d.done({ verb: KEY_WAIT[data]!, row: this.sel, zone: "waits" });
			return; // r on an open wait, c on a closed one
		}
		this.d.tui.requestRender();
	}

	/** Lines of the last render that hold row k, and wait k. */
	private rowLine: number[] = [];
	private waitLine: number[] = [];

	/**
	 * Click-only, so drag-select still works: a row selects it, the selected row
	 * again or the title closes the picker (the same click that opened it).
	 */
	handleMouse(e: { type: string; button: string; y: number }): { handled: boolean } | undefined {
		if (e.type !== "click" || e.button !== "left") return undefined;
		if (e.y === 0) {
			this.d.done(undefined);
			return { handled: true };
		}
		const r = this.rowLine.indexOf(e.y);
		const wt = this.waitLine.indexOf(e.y);
		const zone = r >= 0 ? "rows" : wt >= 0 ? "waits" : undefined;
		if (!zone) return undefined;
		const k = zone === "rows" ? r : wt;
		if (zone === this.zone && k === this.sel) this.d.done(undefined);
		else {
			this.zone = zone;
			this.sel = k;
			this.d.tui.requestRender();
		}
		return { handled: true };
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, rows } = this.d;
		const dim = (s: string) => theme.fg("dim", s);
		const out = [truncateToWidth(theme.fg("accent", this.d.title), width), ""];
		if (!rows.length) out.push(dim("  Nothing needs you."));
		this.rowLine = [];
		rows.forEach((r, k) => {
			this.rowLine[k] = out.length;
			const count = r.count > 1 ? ` ${theme.fg("warning", `×${r.count}`)}` : "";
			const tail = ` ${dim(r.age)}`;
			const head = `${k + 1} ${r.icon} `;
			const room = Math.max(10, width - 4 - visibleWidth(head) - visibleWidth(count) - visibleWidth(tail));
			const line = `${head}${truncateToWidth(r.label, room)}${count}${tail}`;
			out.push(truncateToWidth(this.zone === "rows" && k === this.sel ? `${theme.fg("accent", "❯")} ${line}` : `  ${line}`, width));
		});
		const waits = this.d.waits ?? [];
		this.waitLine = [];
		if (waits.length) {
			out.push("", truncateToWidth(dim(`Waiting on${this.zone === "rows" ? " · tab" : ""}`), width));
			waits.forEach((w, k) => {
				this.waitLine[k] = out.length;
				const mark = w.state === "closed" ? theme.fg("success", "✓") : theme.fg("warning", "⧗");
				const body = w.state === "closed" ? dim(w.line) : w.state === "maybe" ? `${w.line} ${theme.fg("warning", "· maybe answered")}` : w.line;
				const sel = this.zone === "waits" && k === this.sel;
				out.push(truncateToWidth(`${sel ? theme.fg("accent", "❯") : " "} ${mark} ${body}`, width));
			});
		}
		if (this.d.flash) out.push("", truncateToWidth(`  ${this.d.flash}`, width));
		const undo = this.d.canUndo ? " · u undo" : "";
		let keys: string;
		if (this.zone === "waits") {
			const cur = waits[this.sel];
			const can = cur ? WAIT_CAN[cur.state] : [];
			const word: Record<WaitVerb, string> = { close: "c close", drop: "x drop", reopen: "r reopen" };
			keys = `${can[0] ? `enter ${can[0]} · ` : ""}${can.map((v) => word[v]).join(" · ")}${undo} · tab back · esc or click to close`;
		} else {
			const cur = rows[this.sel];
			keys = `${cur ? `enter ${VERB_WORD[cur.verb]} · ` : ""}o open · a ask agent · d done · s snooze · m mute · w wait${undo} · esc or click to close`;
		}
		out.push("", truncateToWidth(dim(keys), width));
		return out;
	}
}
