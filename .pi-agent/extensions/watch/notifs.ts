/**
 * watch/notifs.ts — notifications that become watcher items: texts, Outlook
 * and Teams, missed calls, calendar alerts. Pure: no pi, no I/O. Not an
 * extension: pi loads only top-level files and folders with an index.ts.
 *
 *   kind     msgs → "text" (personal scout), work → "work" (work scout),
 *            Phone/FaceTime → "call" (rules: a missed call needs Eric, no model),
 *            Calendar/Fantastical → "event" (work scout). Slack and mail
 *            banners make no item: they only bring a read forward.
 *   dedupe   one message on the Mac and the iPhone is one item: same app,
 *            sender and text, minutes apart. Its readKeys hold both ids.
 *   clear    an item clears when any of its notifications goes away: Eric
 *            handled it on some device. After a notif-watch (re)start, the
 *            ones not replayed by --since are gone too, per source that read ok.
 */

import type { AppDef } from "./apps.ts";
import type { NotifSrc, Posted } from "./notif.ts";

export type NotifKind = "text" | "work" | "call" | "event";
export const NOTIF_KINDS: ReadonlySet<string> = new Set<NotifKind>(["text", "work", "call", "event"]);
/** How far back notif-watch replays at each start, so restarts find what's still on screen. */
export const NOTIF_SINCE = "24h";
export const NOTIF_SINCE_MS = 24 * 3600_000;
/** Two copies of one message land this close together, or they're two messages. */
export const SAME_WINDOW_S = 180;

const PREFIX = "notif:";
export const notifKey = (id: string) => `${PREFIX}${id}`;
export const isNotifKey = (k: string) => k.startsWith(PREFIX);
export const notifIdsOf = (readKeys: readonly string[]) => readKeys.filter(isNotifKey).map((k) => k.slice(PREFIX.length));
/** notif-watch ids start with their source: "mac:…", "iphone:…". */
export const srcOfId = (id: string): NotifSrc | "" => (id.startsWith("mac:") ? "mac" : id.startsWith("iphone:") ? "iphone" : "");

type App = Pick<AppDef, "name" | "route"> & { group: string };

/** The kind of item a notification makes; null for a Slack or mail banner, or a call that wasn't missed. */
export function notifKind(app: App, missed: boolean): NotifKind | null {
	if (app.group === "msgs") return "text";
	if (app.group === "work") return "work";
	if (app.group === "calls") return app.route === "rules" ? (missed ? "call" : null) : "event";
	return null;
}

export type NotifFields = {
	key: string;
	workspace: NotifSrc; // the device: never a Slack workspace
	channel: string; // the app: "Messages", "Teams"
	where: string; // "iPhone · Teams"
	from: string;
	text: string;
	ts: string; // seconds, like a Slack ts, from the notification's time
	kind: NotifKind;
	route: "work" | "personal" | null; // null: rules only, no model
	forced: boolean;
	readKeys: string[];
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * One notification as item fields. A text or Teams message is "sender — text";
 * Outlook adds its subject. A missed call is the caller. A calendar alert is
 * the event and when.
 */
export function notifFields(e: Posted, app: App, kind: NotifKind, now: number, max = 500): NotifFields {
	const at = Date.parse(e.at);
	const t = Number.isFinite(at) && at <= now + 60_000 ? at : now;
	const title = squash(e.title);
	const sub = squash(e.subtitle);
	const body = squash(e.body);
	const sender = squash(e.sender);
	let from: string;
	let parts: string[];
	if (kind === "event") {
		from = app.name;
		parts = [title, sub, body];
	} else if (kind === "call") {
		from = [sender, title, body].find((x) => x && !/\bmissed\b/i.test(x)) || "unknown caller";
		parts = [[title, body].find((x) => /\bmissed\b/i.test(x)) ?? "missed call"];
	} else {
		from = sender || title || app.name;
		parts = [title && title !== from ? title : "", sub, body]; // a group name or a subject, then the text
	}
	return {
		key: notifKey(e.id),
		workspace: e.src,
		channel: app.name,
		where: `${e.src === "mac" ? "Mac" : "iPhone"} · ${app.name}`,
		from: from.slice(0, 120),
		text: parts.filter(Boolean).join(" — ").slice(0, max),
		ts: (t / 1000).toFixed(6),
		kind,
		route: kind === "text" ? "personal" : kind === "call" ? null : "work",
		forced: kind === "call",
		readKeys: [notifKey(e.id)],
	};
}

type Like = { key: string; kind: string; channel: string; from: string; text: string; ts: string };
const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/**
 * The same message from two places: same kind, app, sender and text (the first
 * 60 characters, since one device may cut it shorter), at most SAME_WINDOW_S apart.
 */
export function sameNotif(a: Like, b: Like, windowS = SAME_WINDOW_S): boolean {
	if (a.key === b.key || !isNotifKey(a.key) || !isNotifKey(b.key)) return false;
	if (a.kind !== b.kind || a.channel !== b.channel || norm(a.from) !== norm(b.from)) return false;
	const ta = norm(a.text).slice(0, 60);
	const tb = norm(b.text).slice(0, 60);
	return ta === tb && Math.abs(Number(a.ts) - Number(b.ts)) <= windowS;
}

type Clearable = { key: string; state: string; bucket: string; readKeys: string[] };

/** Open notification items with a notification that's gone: cleared as read. */
export function clearNotifs<T extends Clearable>(items: Iterable<T>, gone: (id: string) => boolean, now: string): T[] {
	const out: T[] = [];
	for (const it of items) {
		if (it.state !== "open" || it.bucket === "drop" || !isNotifKey(it.key)) continue;
		if (notifIdsOf(it.readKeys).some(gone)) out.push({ ...it, state: "cleared", clearedAt: now, clearedBy: "read" });
	}
	return out;
}

/**
 * After notif-watch's first read: an id is gone when its source read ok and
 * the --since replay didn't list it. A source that failed judges nothing.
 */
export const goneAfterReplay =
	(replayed: ReadonlySet<string>, judged: ReadonlySet<string>) =>
	(id: string): boolean =>
		judged.has(srcOfId(id)) && !replayed.has(id);
