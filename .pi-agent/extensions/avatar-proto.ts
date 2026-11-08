// PROTOTYPE (Botsun session, 2026-11-06): this session's Botsun look as an animated avatar in the
// footer, left of the session name (footer:name-badge), played by the terminal itself (Kitty graphics animation, Ghostty 1.4+)
// through tmux passthrough with U=1 Unicode placeholders. Loops while the agent works, rests on
// frame 1 when idle. Follows the look and color saved on Botsun (a phone change shows within ~5 s).
//
// Prototype shortcuts, to be replaced by the real feature: the look is read straight from the
// local Botsun database (read-only psql, settings key session_icon:<pi session id>; the real one
// gets it through botsun-owner). A /icon pick redraws at once: botsun-owner's "botsun:icon" event
// ({look, color}) carries it before Botsun answers, and the poll stands aside for a moment after,
// so it can't put the old look back before Botsun has saved the new one, and frames come from Botsun's exported strips
// (~/.local/share/botsun/icons/<look>/<color>.png, `bin/botsun icons export`: idle, a 2-frame
// blink, then 24 busy frames, 128 px each; the manifest says where each starts), cut with
// ImageMagick into ~/tmp/avatar-proto/cache. Idle is its own image, looping the idle frame with a
// blink every few seconds; working swaps the badge to a second image that loops the busy frames.
// Active only when ~/tmp/avatar-proto/enabled exists. Delete this file to remove.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const DIR = join(homedir(), "tmp/avatar-proto");
const ICONS = join(homedir(), ".local/share/botsun/icons");
const POLL_MS = 5000;
const DB = process.env.BOTSUN_DATABASE_URL || "postgres:///botsun";

const inTmux = () => !!process.env.TMUX;
const wrap = (seq: string) => (inTmux() ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq);
const apc = (keys: string, payload = "") => wrap(`\x1b_G${keys}${payload ? `;${payload}` : ""}\x1b\\`);

/** Send a PNG in <=4096-byte base64 chunks; keys go on the first chunk only. */
function send(keys: string, png: Buffer): string {
	const b64 = png.toString("base64");
	const parts: string[] = [];
	for (let i = 0; i < b64.length; i += 4096) parts.push(b64.slice(i, i + 4096));
	return parts.map((p, n) => apc(n === 0 ? `${keys},m=${n === parts.length - 1 ? 0 : 1}` : `m=${n === parts.length - 1 ? 0 : 1}`, p)).join("");
}

const placeholderFor = (id: number) =>
	`\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m\u{10EEEE}\u0305\u0305\u{10EEEE}\u0305\u030D\x1b[39m`;

type Look = { icon: string; color: string };
const SAFE = /^[a-z0-9.]{1,40}$/;

export default function (pi: ExtensionAPI) {
	if (!existsSync(join(DIR, "enabled"))) return;
	let id = 0;
	let working = false;
	let look: Look | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	const write = (s: string) => process.stdout.write(s);

	async function savedLook(sessionId: string): Promise<Look> {
		const fallback: Look = { icon: "ghost", color: process.env.PI_SESSION_COLOR || "gray" };
		try {
			if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return fallback;
			const query = `SELECT value FROM settings WHERE key = 'session_icon:${sessionId}'`;
			const { stdout } = await run("psql", ["-At", DB, "-c", query], { timeout: 3000 });
			const v = JSON.parse(stdout.trim() || "{}") as Partial<Look>;
			const icon = typeof v.icon === "string" && SAFE.test(v.icon) ? v.icon : fallback.icon;
			const color = typeof v.color === "string" && SAFE.test(v.color) ? v.color : fallback.color;
			return { icon, color };
		} catch {
			return fallback;
		}
	}

	type Manifest = {
		revision?: string;
		frames?: number;
		idle_index?: number;
		blink_indexes?: number[];
		busy_index?: number;
		busy_frames?: number;
		looks?: Record<string, { frame_ms?: number; colors?: string[] }>;
	};
	const manifest = (): Manifest => {
		try {
			return JSON.parse(readFileSync(join(ICONS, "manifest.json"), "utf8")) as Manifest;
		} catch {
			return {};
		}
	};
	let idleId = 0;
	let busyId = 0;
	const badge = () => {
		const shown = working ? busyId : idleId;
		if (shown) pi.events.emit("footer:name-badge", { text: placeholderFor(shown) }); // left of the session name
	};
	const newId = () => 0x100000 + Math.floor(Math.random() * 0xeffff); // 24-bit: the placeholders' foreground carries it

	async function show(want: Look) {
		const m = manifest();
		const entry = m.looks?.[want.icon] ? want.icon : "ghost";
		const color = m.looks?.[entry]?.colors?.includes(want.color) ? want.color : "gray";
		const strip = join(ICONS, entry, `${color}.png`);
		if (!existsSync(strip)) return;
		const out = join(DIR, "cache", `${entry}-${color}-${m.revision ?? "x"}`);
		const count = m.frames ?? 9;
		if (!existsSync(join(out, `f${count - 1}.png`))) {
			await run("mkdir", ["-p", out]);
			// 128 px frames scaled to 64 px: two cells wide is plenty, and a quarter of the bytes.
			await run("magick", [strip, "-crop", "128x128", "+repage", "-resize", "64x64", join(out, "f%d.png")], { timeout: 20000 });
		}
		const frames = Array.from({ length: count }, (_, i) => readFileSync(join(out, `f${i}.png`)));
		const idle = frames[m.idle_index ?? 0];
		const blinks = (m.blink_indexes ?? []).map((i) => frames[i]).filter(Boolean);
		const busyFrom = m.busy_index ?? 1;
		const busy = frames.slice(busyFrom, busyFrom + (m.busy_frames ?? count - busyFrom));
		const gap = Math.max(40, Math.round(m.looks?.[entry]?.frame_ms ?? 120));
		if (!idle || !busy[0]) return; // a strip with too few frames: keep the last avatar
		const first = busy[0];
		const old = [idleId, busyId];
		idleId = newId();
		busyId = newId();
		// Idle: the idle frame for ~4 s, then a blink (half shut, shut, half shut), looping.
		let seq = send(`a=t,f=100,i=${idleId},q=2`, idle);
		if (blinks.length) {
			const shut = [...blinks, ...blinks.slice(0, -1).reverse()];
			shut.forEach((f, n) => f && (seq += send(`a=f,f=100,i=${idleId},z=${n === blinks.length - 1 ? 90 : 50},q=2`, f)));
			seq += apc(`a=a,i=${idleId},r=1,z=${3600 + Math.floor(Math.random() * 1200)},q=2`); // the open eyes' own gap
			seq += apc(`a=a,i=${idleId},s=3,v=1,q=2`);
		}
		seq += apc(`a=p,U=1,i=${idleId},c=2,r=1,q=2`); // virtual placement: 2 cells x 1 row
		seq += send(`a=t,f=100,i=${busyId},q=2`, first);
		for (const f of busy.slice(1)) if (f) seq += send(`a=f,f=100,i=${busyId},z=${gap},q=2`, f);
		seq += apc(`a=a,i=${busyId},r=1,z=${gap},q=2`); // the first busy frame's own gap
		seq += apc(`a=p,U=1,i=${busyId},c=2,r=1,q=2`);
		seq += apc(`a=a,i=${busyId},s=3,v=1,q=2`); // loops forever; only shown while working
		write(seq);
		id = busyId;
		badge();
		for (const o of old) if (o) write(apc(`a=d,d=I,i=${o},q=2`));
		look = want;
	}

	// One render at a time, in order: a pick queued behind a poll still lands.
	let chain: Promise<void> = Promise.resolve();
	const queue = (fn: () => Promise<void>) => (chain = chain.then(fn).catch(() => {}));
	let sessionId = "";
	let pickedAt = 0;

	async function refresh(force = false) {
		if (busy && !force) return;
		if (!force && Date.now() - pickedAt < POLL_MS * 2) return; // a pick's save may not be in yet
		busy = true;
		await queue(async () => {
			try {
				const next = await savedLook(sessionId);
				if (!look || next.icon !== look.icon || next.color !== look.color) await show(next);
			} catch {
				// prototype: a failed render keeps the last avatar
			}
		});
		busy = false;
	}

	pi.events.on("botsun:icon", (v: unknown) => {
		if (!id && !idleId) return; // not drawing (no UI, or before session_start)
		const { look: want, color } = (v ?? {}) as { look?: unknown; color?: unknown };
		if (typeof want === "string" && SAFE.test(want)) {
			pickedAt = Date.now();
			const c = typeof color === "string" && SAFE.test(color) ? color : look?.color ?? process.env.PI_SESSION_COLOR ?? "gray";
			void queue(async () => {
				if (look?.icon === want && look.color === c) return;
				await show({ icon: want, color: c });
			});
		} else {
			pickedAt = 0;
			void refresh(true); // automatic: whatever Botsun has saved (or the fallback),
			setTimeout(() => void refresh(true), 1500).unref?.(); // and again once its clear is in
		}
	});

	const play = (on: boolean) => {
		if (on === working) return;
		working = on;
		badge();
	};

	pi.on("session_start", async (_e, ctx) => {
		if (!ctx.hasUI) return;
		sessionId = ctx.sessionManager?.getSessionId?.() || process.env.PI_SESSION_ID || "";
		await refresh(true);
		timer = setInterval(() => void refresh(), POLL_MS);
		timer.unref?.();
	});
	pi.on("agent_start", async () => play(true));
	pi.on("agent_end", async () => play(false));
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		pi.events.emit("footer:name-badge", { text: "" });
		for (const o of [idleId, busyId]) if (o) write(apc(`a=d,d=I,i=${o},q=2`)); // free the images and frames
		id = idleId = busyId = 0;
	});
}
