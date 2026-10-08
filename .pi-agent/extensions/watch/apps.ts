/**
 * watch/apps.ts — which notifications the watcher asks notif-watch for, and
 * where each kind goes. Not an extension: pi loads only top-level files and
 * folders with an index.ts.
 *
 * Every app not listed here is dropped inside notif-watch: its text never
 * reaches pi. Groups follow Eric's answers on the watch-all plan:
 *
 *   slack  Slack, Mac and iPhone        wake: an early slk read, no text kept
 *   mail   Mail, Fastmail               wake: an early mail read (counted until watch/mail.ts)
 *   work   Outlook, Teams               the work scout (VA Copilot), rules if it fails
 *   calls  Phone, FaceTime              rules: a missed call needs Eric
 *          Calendar, Fantastical        the work scout: work meetings live there
 *   msgs   Messages, Signal             the personal scout, OTP codes masked first
 *
 * PI_WATCH_APPS=slack,mail,work,calls,msgs picks groups; "" or "off" turns
 * notifications off.
 */

export type AppRoute = "wake" | "rules" | "work" | "personal";
export type Device = "mac" | "iphone";
export type AppDef = { id: string; name: string; device: Device; route: AppRoute };
export type AppGroup = { key: string; label: string; apps: AppDef[] };

const app = (id: string, name: string, device: Device, route: AppRoute): AppDef => ({ id, name, device, route });

/** Bundle ids as each store writes them; matched in any case (the Mac store lowercases some). */
export const APP_GROUPS: readonly AppGroup[] = [
	{
		key: "slack",
		label: "Slack",
		apps: [app("com.tinyspeck.slackmacgap", "Slack", "mac", "wake"), app("com.tinyspeck.chatlyio", "Slack", "iphone", "wake")],
	},
	{
		key: "mail",
		label: "Mail",
		apps: [
			app("com.apple.mail", "Mail", "mac", "wake"),
			app("com.apple.mobilemail", "Mail", "iphone", "wake"),
			app("com.fastmail.FastMail", "Fastmail", "iphone", "wake"),
		],
	},
	{
		key: "work",
		label: "Outlook, Teams",
		apps: [
			app("com.microsoft.Outlook", "Outlook", "mac", "work"),
			app("com.microsoft.teams2", "Teams", "mac", "work"),
			app("com.microsoft.Office.Outlook", "Outlook", "iphone", "work"),
			app("com.microsoft.skype.teams", "Teams", "iphone", "work"),
		],
	},
	{
		key: "calls",
		label: "Phone, Calendar",
		apps: [
			app("com.apple.mobilephone", "Phone", "mac", "rules"),
			app("com.apple.mobilephone", "Phone", "iphone", "rules"),
			app("com.apple.facetime", "FaceTime", "mac", "rules"),
			app("com.apple.facetime", "FaceTime", "iphone", "rules"),
			app("com.apple.ical", "Calendar", "mac", "work"),
			app("com.apple.mobilecal", "Calendar", "iphone", "work"),
			app("85C27NK92C.com.flexibits.fantastical2.mac.helper", "Fantastical", "mac", "work"),
			app("com.flexibits.fantastical2.iphone", "Fantastical", "iphone", "work"),
		],
	},
	{
		key: "msgs",
		label: "Messages, Signal",
		apps: [
			app("com.apple.MobileSMS", "Messages", "mac", "personal"),
			app("com.apple.MobileSMS", "Messages", "iphone", "personal"),
			app("org.whispersystems.signal-desktop", "Signal", "mac", "personal"),
			app("org.whispersystems.signal", "Signal", "iphone", "personal"),
		],
	},
];

export const DEFAULT_APPS = "slack,mail,work,calls,msgs";

/** "slack, work" → those groups, in table order; "" / "off" / "none" → none. */
export function pickGroups(spec: string, all: readonly AppGroup[] = APP_GROUPS): { groups: AppGroup[]; unknown: string[] } {
	const want = spec
		.toLowerCase()
		.split(/[\s,]+/)
		.filter((k) => k && k !== "off" && k !== "none");
	const known = new Set(all.map((g) => g.key));
	return { groups: all.filter((g) => want.includes(g.key)), unknown: [...new Set(want.filter((k) => !known.has(k)))] };
}

/** The ids for notif-watch --allow: one each, any device. */
export const allowList = (groups: readonly AppGroup[]) => [...new Set(groups.flatMap((g) => g.apps.map((a) => a.id)))].sort();

/** An app id from either store, matched in any case; the device picks Phone on the Mac from Phone on the iPhone. */
export function appFor(id: string, device: Device, groups: readonly AppGroup[] = APP_GROUPS): (AppDef & { group: string }) | undefined {
	const lc = id.toLowerCase();
	for (const g of groups) {
		const hit = g.apps.find((a) => a.id.toLowerCase() === lc && a.device === device) ?? g.apps.find((a) => a.id.toLowerCase() === lc);
		if (hit) return { ...hit, group: g.key };
	}
	return undefined;
}

export const ROUTE_LABEL: Record<AppRoute, string> = {
	wake: "wake",
	rules: "rules",
	work: "work scout",
	personal: "personal scout",
};

/** What each route does; a route not here is counted only. */
export const ROUTE_DOES: Record<string, string> = {
	"slack:wake": "an early Slack read",
	"work:work": "items",
	"calls:rules": "missed calls need you",
	"calls:work": "items",
	"msgs:personal": "items",
};

export type AppsView = {
	groups: readonly AppGroup[]; // on
	state: string; // "Mac ok · iPhone ok", "off", "notif-watch missing"
	seen: Record<string, number>; // "group:route" → posted this session
	onScreen: Record<string, number>; // "group:route" → on screen now
	dropped: number;
};

/** `/watch apps`: each group on or off, one row per route, with counts. Never notification text. */
export function appsText(v: AppsView, all: readonly AppGroup[] = APP_GROUPS): string {
	const lines = [`watch · apps · notifications: ${v.state}`, "on  route           apps                                seen  now"];
	for (const g of all) {
		const on = v.groups.some((x) => x.key === g.key);
		const routes = [...new Set(g.apps.map((a) => a.route))];
		for (const r of routes) {
			const apps = g.apps.filter((a) => a.route === r);
			const names = [...new Set(apps.map((a) => a.name))].join(", ");
			const devices = [...new Set(apps.map((a) => (a.device === "mac" ? "Mac" : "iPhone")))].join(", ");
			const key = `${g.key}:${r}`;
			const does = ROUTE_DOES[key];
			const what = `${names} (${devices})${does ? ` → ${does}` : ""}`;
			const counts = on ? `${String(v.seen[key] ?? 0).padStart(4)}  ${String(v.onScreen[key] ?? 0).padStart(3)}` : "";
			lines.push(`${on ? "✓" : "✕"}   ${(on ? ROUTE_LABEL[r] : "—").padEnd(15)} ${what.padEnd(35)} ${counts}`.trimEnd());
		}
	}
	lines.push(`✕   —               every other app: dropped in notif-watch${v.dropped ? `, ${v.dropped} this session` : ""}`);
	lines.push("Mail banners are counted until the mail reader lands. A removed notification clears its item. PI_WATCH_APPS picks groups.");
	return lines.join("\n");
}
