/**
 * watch/policy.ts — when the watcher may speak up, and how loudly. Pure: no pi
 * and no I/O, so every rule tests without a session. Not an extension (see
 * models.ts).
 *
 * Levels, quiet to loud:
 *   widget   a row above the editor (every "needs you" item)
 *   nudge    a toast: urgent words, 3 pings in 30 min, a VIP, a missed call
 *   offer    a widget line; nothing runs until Eric types /watch do N
 *   held     an act that waits on a gate (a meeting, Eric typing, the gap)
 *   act      the watcher starts a turn by itself: prep, away or urgent only
 *
 * The scout can only propose an offer. Rules make nudges and act cases, and
 * code gates every act: no meeting, work hours, Eric idle, the budget, and the
 * route (a work item acts only in a VA Copilot session).
 */

export type Level = "widget" | "nudge" | "offer" | "held" | "act";
export type ActCase = "prep" | "away" | "urgent";
export type OfferKind = "draft" | "look";
export type Route = "work" | "personal";

/** What policy reads from an item: a structural slice of watch.ts's Item. */
export type PItem = {
	key: string;
	ts: string; // Slack ts, seconds
	workspace: string;
	channel: string;
	threadTs?: string;
	where: string;
	from: string;
	kind: string;
	text: string;
	why: string;
	bucket: string;
	state: string;
	offer?: OfferKind;
	offerWhy?: string;
	nudge?: string;
};

/** A timed work meeting from ical (see prep.ts). */
export type Meeting = { key: string; id: string; title: string; start: string; who: string[] };

export type Candidate = {
	key: string; // one each thread, meeting or batch
	case?: ActCase; // set: code may start a turn; unset: an offer at most
	offer?: { kind: OfferKind; why: string };
	nudge?: string;
	items: PItem[];
	meeting?: Meeting;
	route: Route;
	who: string; // the person (or meeting) quiet and ignored count against
	what: string; // a short label for the widget and /watch wakes
	workspace: string | null; // the one Slack workspace watch_lookup may search; null: none
};

export type Decision = { at: string; key: string; level: Level; why: string; who: string; what: string };

export type PolicyState = {
	day: string; // YYYY-MM-DD; acts, fired, offered and log reset at midnight
	acts: { at: string; key: string; case: ActCase }[]; // today's self-started acts, for the budget
	lastActAt: number;
	fired: string[]; // candidate and item keys that acted
	offered: Record<string, string>; // offer key → who, while it shows
	ignored: Record<string, number>; // person → offers ignored in a row
	quiet: Record<string, string>; // person → until (local ISO)
	loud: string[]; // VIPs added with /watch loud
	log: Decision[]; // today's level changes, for /watch wakes
};

export type PolicyView = {
	now: number;
	nowIso: string;
	meeting: boolean;
	workHours: boolean;
	idle: boolean; // ctx.isIdle()
	pending: boolean; // ctx.hasPendingMessages()
	editorText: boolean; // Eric has a half-typed prompt
	lastInputAt: number;
	sessionWork: boolean; // the session model is on VA Copilot
	actsToday: number;
	lastActAt: number;
	perDay: number;
	gapMs: number;
	quiet: (who: string) => boolean;
};

export const DIRECT = new Set(["dm", "group", "mention"]);
export const URGENT = /\b(urgent|asap|blocker|blocking|emergency)\b/i;
/** Nudges that also make an urgent act candidate. */
export const ACTING_NUDGES = new Set(["urgent", "3 pings in 30 min"]);
const PING_WINDOW_S = 30 * 60;
/** An offer goes away (and counts as ignored) after this long. */
export const OFFER_TTL_MS = 4 * 3600_000;
/** A prep candidate this long before the meeting starts. */
export const PREP_LEAD_MS = 10 * 60_000;
export const AWAY_SEC = 20 * 60;
/** Eric typed this recently: hold every act but away. */
export const TYPED_MS = 2 * 60_000;
export const IGNORED_MAX = 3;
export const QUIET_DAYS = 7;
const LOG_KEPT = 200;

const KIND_WORD: Record<string, string> = { dm: "DM", group: "group DM", mention: "@-mention" };
const firstName = (name: string) => name.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/)[0] || name;
export const personKey = (who: string) => who.toLowerCase().replace(/\s+/g, " ").trim();

// ── nudges ───────────────────────────────────────────────────────────────────

/** The rule that makes an item a nudge, or "" for none. The scout cannot add one. */
export function nudgeOf(i: PItem, recent: readonly PItem[], isVip: (who: string) => boolean): string {
	if (!DIRECT.has(i.kind)) return "";
	const vip = isVip(i.from);
	if (URGENT.test(i.text) && (vip || i.kind === "dm")) return "urgent";
	const t = Number(i.ts);
	const same = new Set(recent.filter((r) => r.from === i.from && DIRECT.has(r.kind) && Math.abs(Number(r.ts) - t) <= PING_WINDOW_S).map((r) => r.key));
	same.add(i.key);
	if (same.size >= 3) return "3 pings in 30 min";
	if (vip) return `VIP ${KIND_WORD[i.kind] ?? i.kind}`;
	return "";
}

/** Phone or FaceTime, on the Mac or the iPhone. */
export const isMissedCall = (app: string, title: string, body: string) => /^(phone|facetime)$/i.test(app) && /\bmissed\b/i.test(`${title} ${body}`);

// ── candidates ───────────────────────────────────────────────────────────────

const whoOf = (items: readonly PItem[]) => {
	const names = [...new Set(items.map((i) => i.from))];
	return names.length === 1 ? names[0]! : names.length === 2 ? names.map(firstName).join(", ") : `${names.length} people`;
};

/** The scout's offer on one open item, until it acts, clears or is 4 hours old. */
export function offerCase(i: PItem, route: Route, fired: ReadonlySet<string>, now: number): Candidate | null {
	if (!i.offer || i.state !== "open" || i.bucket !== "needs" || fired.has(i.key)) return null;
	if (now - Number(i.ts) * 1000 > OFFER_TTL_MS) return null;
	const why = i.offerWhy || (i.offer === "draft" ? "draft a reply" : "find what it names");
	return { key: i.key, offer: { kind: i.offer, why }, items: [i], route, who: i.from, what: `${firstName(i.from)} · ${i.why || why}`, workspace: i.workspace };
}

/** An urgent nudge: one turn for the conversation, with every open ping in it. Not for a backlog item over 4 hours old. */
export function urgentCase(i: PItem, related: readonly PItem[], route: Route, fired: ReadonlySet<string>, now: number): Candidate | null {
	if (!i.nudge || !ACTING_NUDGES.has(i.nudge) || i.state !== "open" || now - Number(i.ts) * 1000 > OFFER_TTL_MS) return null;
	const key = `urgent:${i.workspace}:${i.channel}:${i.threadTs ?? ""}`;
	if (fired.has(key)) return null;
	const items = [i, ...related.filter((r) => r.key !== i.key && r.from === i.from && r.state === "open")];
	return { key, case: "urgent", nudge: i.nudge, items, route, who: i.from, what: `${firstName(i.from)} · ${i.why || i.nudge}`, workspace: i.workspace };
}

/** Away from the Mac: one candidate each workspace for all open questions, not one turn each. */
export function awayCases(needs: readonly PItem[], idleSec: number, fired: ReadonlySet<string>, routeOf: (ws: string) => Route, awaySec = AWAY_SEC): Candidate[] {
	if (idleSec < awaySec) return [];
	const qs = needs.filter((i) => i.state === "open" && DIRECT.has(i.kind) && i.offer === "draft" && !fired.has(i.key));
	const byWs = new Map<string, PItem[]>();
	for (const i of qs) byWs.set(i.workspace, [...(byWs.get(i.workspace) ?? []), i]);
	return [...byWs].map(([ws, items]) => ({
		key: `away:${items.map((i) => i.key).join(",")}`,
		case: "away" as const,
		items,
		route: routeOf(ws),
		who: whoOf(items),
		what: `${items.length} question${items.length === 1 ? "" : "s"}`,
		workspace: ws,
	}));
}

/** A work meeting that starts within PREP_LEAD_MS. */
export function prepCase(m: Meeting, now: number, fired: ReadonlySet<string>, workspace: string | null, lead = PREP_LEAD_MS): Candidate | null {
	const start = Date.parse(m.start);
	if (!Number.isFinite(start) || start <= now || start - now > lead || fired.has(m.key)) return null;
	const d = new Date(start);
	const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return { key: m.key, case: "prep", meeting: m, items: [], route: "work", who: m.title, what: `${m.title} ${hhmm}`, workspace };
}

// ── decide ───────────────────────────────────────────────────────────────────

/** Work text reaches a turn only on VA Copilot; personal text already reaches the session in digests. */
export const routeOk = (route: Route, sessionWork: boolean) => route === "personal" || sessionWork;

/** "prep · Platform Sync 11:00", "Kim · ATO date?": what the widget and /watch wakes show. */
export const candLabel = (c: Pick<Candidate, "case" | "what">) => (c.case ? `${c.case} · ${c.what}` : c.what);

export function decide(c: Candidate, v: PolicyView): Decision {
	const d = (level: Level, why: string): Decision => ({ at: v.nowIso, key: c.key, level, why, who: c.who, what: candLabel(c) });
	if (v.quiet(c.who)) return d("widget", "quiet");
	if (!routeOk(c.route, v.sessionWork)) return d(c.nudge ? "nudge" : "widget", "route: session model");
	if (!c.case) {
		if (c.offer) return d("offer", `scout: ${c.offer.kind}`);
		return d(c.nudge ? "nudge" : "widget", c.nudge ?? "no rule");
	}
	const g = gate(c, v);
	if (!g) return d("act", `rule: ${c.case}`);
	return d(g.hold ? "held" : "offer", `gate: ${g.why}`);
}

/** null: the act may start. hold: it waits and acts later. Otherwise it becomes an offer. */
export function gate(c: Candidate, v: PolicyView): { hold: boolean; why: string } | null {
	const hold = (why: string) => ({ hold: true, why });
	if (v.meeting) return hold("in a meeting");
	if (!v.workHours) return { hold: false, why: "after hours" };
	if (!v.idle || v.pending || v.editorText) return hold("you are busy");
	if (c.case !== "away" && v.now - v.lastInputAt < TYPED_MS) return hold("you typed just now");
	if (v.actsToday >= v.perDay) return { hold: false, why: "budget for today" };
	if (c.case !== "prep" && v.now - v.lastActAt < v.gapMs) return hold(`1 each ${Math.round(v.gapMs / 60_000)} min`);
	return null;
}

// ── config ───────────────────────────────────────────────────────────────────

/** PI_WATCH_ACTS="12/15": 12 self-started acts each day, 1 each 15 minutes. */
export function parseBudget(spec: string | undefined): { perDay: number; gapMs: number } {
	const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(spec ?? "");
	return m ? { perDay: Number(m[1]), gapMs: Number(m[2]) * 60_000 } : { perDay: 12, gapMs: 15 * 60_000 };
}

/** Mon-Fri, start ≤ hour < end. */
export function workHoursAt(d: Date, start = 8, end = 17): boolean {
	const day = d.getDay();
	return day >= 1 && day <= 5 && d.getHours() >= start && d.getHours() < end;
}

/** Seconds since the last key or mouse event, from `ioreg -c IOHIDSystem`; null when unreadable. */
export function parseHidIdle(out: string): number | null {
	const ns = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1]);
	return Number.isFinite(ns) && /HIDIdleTime/.test(out) ? ns / 1e9 : null;
}

/**
 * Seconds Eric has been away: the smaller of the Mac's HID idle time and the
 * time since his last pi input. Over SSH (or from another Mac) typing in pi
 * never touches this Mac's HID clock, so HID alone says "away" while he types.
 * An unreadable HID clock counts as 0: never away on a guess.
 */
export function awayIdleSec(hidSec: number | null, lastInputAt: number, now: number): number {
	if (hidSec === null) return 0;
	return Math.max(0, Math.min(hidSec, (now - lastInputAt) / 1000));
}

// ── state ────────────────────────────────────────────────────────────────────

export const newPolicy = (day: string): PolicyState => ({ day, acts: [], lastActAt: 0, fired: [], offered: {}, ignored: {}, quiet: {}, loud: [], log: [] });

/** Loaded or new: a new day drops acts, fired, offered and log; expired quiet ends. */
export function rollPolicy(p: Partial<PolicyState> | undefined, day: string, now = Date.now()): PolicyState {
	const base = { ...newPolicy(day), ...(p ?? {}) };
	const quiet = Object.fromEntries(Object.entries(base.quiet).filter(([, until]) => Date.parse(until) > now));
	if (base.day === day) return { ...base, quiet };
	return { ...newPolicy(day), ignored: base.ignored, quiet, loud: base.loud };
}

export function pushLog(p: PolicyState, d: Decision) {
	p.log.push(d);
	if (p.log.length > LOG_KEPT) p.log.splice(0, p.log.length - LOG_KEPT);
}

/** A self-started act: it counts against the budget. */
export function recordAct(p: PolicyState, c: Candidate, now: number, nowIso: string) {
	p.acts.push({ at: nowIso, key: c.key, case: c.case ?? "away" });
	p.lastActAt = now;
}

/** Keys that never fire again today: the candidate and its items. */
export function markFired(p: PolicyState, c: Candidate) {
	for (const k of [c.key, ...c.items.map((i) => i.key)]) if (!p.fired.includes(k)) p.fired.push(k);
	delete p.offered[c.key];
}

export const isQuiet = (p: PolicyState, who: string, now = Date.now()) => {
	const until = p.quiet[personKey(who)];
	return !!until && Date.parse(until) > now;
};

const isoPlusDays = (now: number, days: number) => new Date(now + days * 86_400_000).toISOString();

/** An offer went away untaken. The third in a row from one person quiets them for 7 days; returns the until. */
export function noteIgnored(p: PolicyState, who: string, now = Date.now()): string | undefined {
	const k = personKey(who);
	p.ignored[k] = (p.ignored[k] ?? 0) + 1;
	if (p.ignored[k]! < IGNORED_MAX) return undefined;
	delete p.ignored[k];
	return (p.quiet[k] = isoPlusDays(now, QUIET_DAYS));
}

export function noteTaken(p: PolicyState, who: string) {
	delete p.ignored[personKey(who)];
}

export function setQuiet(p: PolicyState, who: string, days: number, now = Date.now()): string {
	return (p.quiet[personKey(who)] = isoPlusDays(now, days));
}

export function setLoud(p: PolicyState, who: string) {
	const k = personKey(who);
	delete p.quiet[k];
	delete p.ignored[k];
	if (!p.loud.some((x) => personKey(x) === k)) p.loud.push(who.trim());
}

/** `"Dana Ruiz" 3d`, `Dana Ruiz 3d`, `Dana Ruiz` (7 days). */
export function parsePersonArgs(rest: string): { who: string; days: number } | null {
	const m = /^\s*(?:"([^"]+)"|(.+?))\s*(?:\s(\d+)\s*d)?\s*$/i.exec(rest);
	const who = (m?.[1] ?? m?.[2] ?? "").trim();
	if (!who) return null;
	return { who, days: m?.[3] ? Math.max(1, Number(m[3])) : QUIET_DAYS };
}

const hhmm = (iso: string) => {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, " ")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** /watch wakes: today's level changes with their rule or gate, and the budget. */
export function wakesText(p: PolicyState, budget: { perDay: number; gapMs: number }, now = Date.now()): string {
	const lines = [`watch · wakes · ${p.day}`];
	const shown = p.log.slice(-30);
	for (const d of shown) lines.push(`${hhmm(d.at)} ${d.level.padEnd(5)} ${d.what.slice(0, 40).padEnd(40)} ${d.why}`);
	if (!shown.length) lines.push("  (no nudges, offers or acts yet today)");
	const next = p.lastActAt + budget.gapMs;
	const left = budget.perDay - p.acts.length;
	lines.push(
		`acts ${p.acts.length} of ${budget.perDay} today${left <= 0 ? " · none left" : next > now ? ` · next act after ${hhmm(new Date(next).toISOString()).trim()}` : ""}`,
	);
	const quiet = Object.entries(p.quiet).filter(([, u]) => Date.parse(u) > now);
	if (quiet.length) lines.push(`quiet: ${quiet.map(([k, u]) => `${k} until ${u.slice(0, 10)}`).join(", ")}`);
	if (p.loud.length) lines.push(`loud: ${p.loud.join(", ")}`);
	return lines.join("\n");
}
