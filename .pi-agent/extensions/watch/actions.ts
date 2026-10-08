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
export type PickerResult = { verb: Verb; row: number };
type Deps = {
	tui: { requestRender(): void };
	theme: { fg(color: string, text: string): string };
	title: string;
	rows: PickerRow[];
	selected: number;
	flash: string; // the last result, shown under the list (may hold an OSC 8 link)
	canUndo: boolean;
	done: (r: PickerResult | undefined) => void;
};

const KEY_VERB: Record<string, Verb> = { o: "open", a: "ask", d: "done", s: "snooze", m: "mute", w: "wait" };
const VERB_WORD: Record<Verb, string> = { open: "open", ask: "ask agent", done: "done", snooze: "snooze", mute: "mute", wait: "wait", undo: "undo" };

/** The list: ↑↓ or j/k to move, a key for each verb, Enter for the row's default. */
export class PickerPanel {
	private readonly d: Deps;
	private sel: number;

	constructor(d: Deps) {
		this.d = d;
		this.sel = Math.max(0, Math.min(d.selected, d.rows.length - 1));
	}

	handleInput(data: string): void {
		const n = this.d.rows.length;
		if (matchesKey(data, "escape") || data === "q") return this.d.done(undefined);
		if (data === "u" && this.d.canUndo) return this.d.done({ verb: "undo", row: this.sel });
		if (!n) return;
		if (matchesKey(data, "up") || data === "k") this.sel = (this.sel - 1 + n) % n;
		else if (matchesKey(data, "down") || data === "j") this.sel = (this.sel + 1) % n;
		else if (matchesKey(data, "enter")) return this.d.done({ verb: this.d.rows[this.sel]!.verb, row: this.sel });
		else if (/^[1-9]$/.test(data) && Number(data) <= n) this.sel = Number(data) - 1;
		else if (KEY_VERB[data]) return this.d.done({ verb: KEY_VERB[data]!, row: this.sel });
		this.d.tui.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, rows } = this.d;
		const dim = (s: string) => theme.fg("dim", s);
		const out = [truncateToWidth(theme.fg("accent", this.d.title), width), ""];
		if (!rows.length) out.push(dim("  Nothing needs you."));
		rows.forEach((r, k) => {
			const count = r.count > 1 ? ` ${theme.fg("warning", `×${r.count}`)}` : "";
			const tail = ` ${dim(r.age)}`;
			const head = `${k + 1} ${r.icon} `;
			const room = Math.max(10, width - 4 - visibleWidth(head) - visibleWidth(count) - visibleWidth(tail));
			const line = `${head}${truncateToWidth(r.label, room)}${count}${tail}`;
			out.push(truncateToWidth(k === this.sel ? `${theme.fg("accent", "❯")} ${line}` : `  ${line}`, width));
		});
		if (this.d.flash) out.push("", truncateToWidth(`  ${this.d.flash}`, width));
		const cur = rows[this.sel];
		out.push(
			"",
			truncateToWidth(
				dim(
					`${cur ? `enter ${VERB_WORD[cur.verb]} · ` : ""}o open · a ask agent · d done · s snooze · m mute · w wait${this.d.canUndo ? " · u undo" : ""} · esc close`,
				),
				width,
			),
		);
		return out;
	}
}
