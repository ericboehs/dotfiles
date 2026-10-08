/**
 * watch/prep.ts — the work meetings a prep brief can be for, from `ical`
 * (EventKit). Notification banners are too sparse for this: in 30 days the
 * stores held one Calendar alert and no Teams or Outlook reminders.
 *
 *   ical calendars -o json              which calendars are work (by source)
 *   ical list -f NOW -t +30m -o json    the next half hour, every 5 minutes
 *
 * Kept: timed events on a work calendar, with 2 or more attendees, not
 * declined, not canceled, and not titled like PI_WATCH_PREP_SKIP. Personal
 * calendars never reach a VA Copilot turn. Not an extension (see models.ts).
 */

import type { Meeting } from "./policy.ts";

export type IcalAttendee = { name?: string; email?: string; status?: number | string };
export type IcalEvent = {
	id: string;
	title: string;
	start_date: string; // UTC, "2026-10-08T15:00:00Z"
	end_date?: string;
	all_day?: boolean;
	calendar?: string;
	calendar_id: string;
	attendees?: IcalAttendee[] | null;
	status?: string;
};
export type IcalCalendar = { id: string; title?: string; source?: string };

export const PREP_SOURCES = ["Oddball (Work)"];
export const PREP_SKIP_WORDS = ["standup", "stand-up", "lunch", "focus", "hold", "ooo", "out of office"];
/** EKParticipantStatus.declined. */
const DECLINED = 3;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "standup,lunch" → a whole-word, case-blind pattern; "" never matches. */
export function skipPattern(words: readonly string[]): RegExp {
	const list = words.map((w) => w.trim()).filter(Boolean);
	return list.length ? new RegExp(`\\b(${list.map(escapeRe).join("|")})\\b`, "i") : /$^/;
}

const parseList = <T>(raw: string): T[] => {
	try {
		const v = JSON.parse(raw) as unknown;
		return Array.isArray(v) ? (v as T[]) : [];
	} catch {
		return [];
	}
};

/** Ids of the calendars whose account (source) is work. */
export function workCalendarIds(raw: string, sources: readonly string[] = PREP_SOURCES): Set<string> {
	const want = new Set(sources.map((s) => s.toLowerCase()));
	return new Set(
		parseList<IcalCalendar>(raw)
			.filter((c) => c && typeof c.id === "string" && want.has(String(c.source ?? "").toLowerCase()))
			.map((c) => c.id),
	);
}

const declined = (a: IcalAttendee) => a.status === DECLINED || String(a.status).toLowerCase() === "declined";

/** Meetings worth a brief; `isMe` spots Eric in the attendee list (name or email). */
export function parseAgenda(raw: string, workIds: ReadonlySet<string>, isMe: (nameOrEmail: string) => boolean, skip = skipPattern(PREP_SKIP_WORDS)): Meeting[] {
	return parseList<IcalEvent>(raw)
		.filter((e) => e && typeof e.id === "string" && typeof e.start_date === "string" && typeof e.title === "string")
		.filter((e) => !e.all_day && workIds.has(e.calendar_id) && !/cancel/i.test(e.status ?? ""))
		.filter((e) => (e.attendees ?? []).length >= 2 && !skip.test(e.title))
		.filter((e) => !(e.attendees ?? []).some((a) => declined(a) && (isMe(a.name ?? "") || isMe(a.email ?? ""))))
		.map((e) => ({
			key: `prep:${e.id}:${e.start_date.slice(0, 10)}`, // one each meeting and day
			id: e.id,
			title: e.title.replace(/\s+/g, " ").trim().slice(0, 80),
			start: e.start_date,
			who: (e.attendees ?? [])
				.map((a) => (a.name || a.email || "").trim())
				.filter((n) => n && !isMe(n))
				.slice(0, 12),
		}));
}

/** ical's -f/-t: ISO in UTC, to the second. */
export const icalTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
