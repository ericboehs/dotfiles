/**
 * watch/notif.ts — runs bin/notif-watch for the watcher and reads its JSON
 * lines. Not an extension: pi loads only top-level files and folders with an
 * index.ts.
 *
 * notif-watch drops every app not on --allow and masks OTP codes and ICNs
 * before it prints, so what reaches here is already allowed and masked. It
 * exits when pi does; the supervisor restarts it if it dies, with a growing
 * delay, and gives up only when the binary is missing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type NotifSrc = "mac" | "iphone";
export type Posted = {
	ev: "posted";
	src: NotifSrc;
	app: string;
	id: string;
	title: string;
	subtitle: string;
	body: string;
	sender: string;
	thread: string;
	at: string; // local ISO time, "" when the store had none
};
export type NotifEvent =
	| Posted
	| { ev: "removed"; src: NotifSrc; app: string; id: string }
	| { ev: "dropped"; src: NotifSrc; app: string; at: string }
	| { ev: "error"; src: string; message: string }
	| { ev: "ok"; src: string }
	| { ev: "ready"; mac: string; iphone: string; allowed: number };

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const isSrc = (v: unknown): v is NotifSrc => v === "mac" || v === "iphone";

/** One line from notif-watch, checked field by field; anything else is null. */
export function parseNotifLine(line: string): NotifEvent | null {
	let o: Record<string, unknown>;
	try {
		const v: unknown = JSON.parse(line);
		if (!v || typeof v !== "object" || Array.isArray(v)) return null;
		o = v as Record<string, unknown>;
	} catch {
		return null;
	}
	const app = str(o.app, 200);
	const id = str(o.id, 400);
	switch (o.ev) {
		case "posted":
			if (!isSrc(o.src) || !app || !id) return null;
			return {
				ev: "posted",
				src: o.src,
				app,
				id,
				title: str(o.title, 300),
				subtitle: str(o.subtitle, 300),
				body: str(o.body),
				sender: str(o.sender, 120),
				thread: str(o.thread, 400),
				at: str(o.at, 40),
			};
		case "removed":
			return isSrc(o.src) && app && id ? { ev: "removed", src: o.src, app, id } : null;
		case "dropped":
			return isSrc(o.src) && app ? { ev: "dropped", src: o.src, app, at: str(o.at, 40) } : null;
		case "error":
			return { ev: "error", src: str(o.src, 20) || "notif-watch", message: str(o.message, 300) };
		case "ok":
			return { ev: "ok", src: str(o.src, 20) };
		case "ready":
			return { ev: "ready", mac: str(o.mac, 20), iphone: str(o.iphone, 20), allowed: Number(o.allowed) || 0 };
		default:
			return null;
	}
}

export type NotifState = "starting" | "running" | "restarting" | "missing" | "stopped";
export type NotifStatus = {
	state: NotifState;
	mac: string; // "ok" | "error" | "off" | "…" before the first read
	iphone: string;
	error: string; // the latest problem, "" once it clears
	restarts: number;
};

/** A short phrase for the widget when something is wrong; "" when all is well. */
export function notifProblem(st: NotifStatus | undefined): string {
	if (!st || st.state === "stopped") return "";
	if (st.state === "missing") return "notif-watch missing";
	if (st.state === "restarting") return "notif-watch restarting";
	const bad = [st.mac === "error" ? "Mac" : "", st.iphone === "error" ? "iPhone" : ""].filter(Boolean);
	return bad.length ? `${bad.join(" and ")} notifications unread` : "";
}

/** "Mac ok · iPhone ok", for the status line and /watch apps. */
export function notifSummary(st: NotifStatus | undefined): string {
	if (!st) return "off";
	if (st.state === "missing" || st.state === "restarting") return `${notifProblem(st)}${st.error ? ` (${st.error})` : ""}`;
	if (st.state === "stopped") return "stopped";
	const parts = [`Mac ${st.mac}`, `iPhone ${st.iphone}`];
	return `${parts.join(" · ")}${st.error ? ` · ${st.error}` : ""}`;
}

export type NotifOptions = {
	bin: string;
	allow: readonly string[];
	extraArgs?: readonly string[];
	onEvent: (e: NotifEvent) => void;
	onStatus?: (st: NotifStatus) => void;
	restartMs?: number; // first restart delay, doubling to maxRestartMs; reset by each "ready"
	maxRestartMs?: number;
};

export type NotifHandle = { stop: () => void; status: () => NotifStatus };

const srcState = (src: string, state: string): Partial<NotifStatus> => (src === "mac" ? { mac: state } : src === "iphone" ? { iphone: state } : {});

export function superviseNotifWatch(o: NotifOptions): NotifHandle {
	const firstDelay = o.restartMs ?? 30_000;
	let delay = firstDelay;
	let child: ChildProcess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const st: NotifStatus = { state: "starting", mac: "…", iphone: "…", error: "", restarts: 0 };
	const set = (p: Partial<NotifStatus>) => {
		Object.assign(st, p);
		o.onStatus?.({ ...st });
	};

	const launch = () => {
		timer = undefined;
		if (stopped || st.state === "missing") return;
		let tail = "";
		const c = spawn(o.bin, ["--follow", "--allow", o.allow.join(","), ...(o.extraArgs ?? [])], { stdio: ["ignore", "pipe", "pipe"] });
		child = c;
		set({ state: "starting" });
		c.on("error", (e: NodeJS.ErrnoException) => {
			if (stopped) return;
			if (e.code === "ENOENT") set({ state: "missing", error: `${o.bin} not on PATH` });
			else set({ error: e.message.slice(0, 200) });
		});
		const lines = createInterface({ input: c.stdout! });
		lines.on("line", (line) => {
			if (stopped || child !== c) return;
			const e = parseNotifLine(line);
			if (!e) return;
			if (e.ev === "ready") {
				delay = firstDelay;
				set({ state: "running", mac: e.mac, iphone: e.iphone });
			} else if (e.ev === "error") {
				set({ error: `${e.src}: ${e.message}`, ...srcState(e.src, "error") });
			} else if (e.ev === "ok") {
				set({ ...srcState(e.src, "ok"), error: st.error.startsWith(`${e.src}:`) ? "" : st.error });
			}
			o.onEvent(e);
		});
		c.stderr!.on("data", (d: Buffer) => {
			tail = (tail + d.toString()).slice(-600);
		});
		c.on("close", (code, signal) => {
			lines.close();
			if (child === c) child = undefined;
			if (stopped || st.state === "missing") return;
			const why = tail.trim().split("\n").at(-1)?.replace(/^notif-watch:\s*/, "") || `exited (${code ?? signal})`;
			set({ state: "restarting", error: why.slice(0, 200), restarts: st.restarts + 1 });
			timer = setTimeout(launch, delay);
			timer.unref?.();
			delay = Math.min(delay * 2, o.maxRestartMs ?? 10 * 60_000);
		});
	};

	launch();
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			if (timer) clearTimeout(timer);
			child?.kill("SIGTERM");
			child = undefined;
			set({ state: "stopped" });
		},
		status: () => ({ ...st }),
	};
}
