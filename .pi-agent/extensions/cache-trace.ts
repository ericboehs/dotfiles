/**
 * cache-trace: a temporary prompt-cache flight recorder for Anthropic-shaped
 * requests (Copilot Claude included).
 *
 * For every request it logs fingerprints of the tools, system prompt and each
 * message (cache_control stripped: pi moves that marker to the last message on
 * every request, and the marker is not part of the cache key). When something
 * the previous request already sent has changed, it records where (a JSON path
 * plus the types/lengths on each side), never the content. On the response it
 * adds cache read/write, the 5m/1h split and Copilot's billed AIU, and flags a
 * miss when less than half of the previous request's cached prefix was read.
 *
 * Log: ~/.local/state/pi-cache-trace/YYYY-MM-DD.jsonl (PI_CACHE_TRACE_DIR
 * overrides). Stops by itself at TRACE_UNTIL; PI_CACHE_TRACE=0 turns it off.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One day of tracing from 2026-10-15 05:00 CDT. */
export const TRACE_UNTIL = Date.parse("2026-10-16T10:00:00Z");
const logDir = () => process.env.PI_CACHE_TRACE_DIR || join(homedir(), ".local", "state", "pi-cache-trace");

type Json = unknown;

/** A deep copy without cache_control keys. */
export function stripCacheControl(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, inner] of Object.entries(value)) if (key !== "cache_control") out[key] = stripCacheControl(inner);
    return out;
  }
  return value;
}

export function fingerprint(value: Json): string {
  return createHash("sha1").update(JSON.stringify(value) ?? "undefined").digest("hex").slice(0, 10);
}

function describe(value: Json): string {
  if (value === undefined) return "absent";
  if (typeof value === "string") return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return `object{${Object.keys(value).sort().join(",")}}`;
  return typeof value;
}

/** The first path where a and b differ, with a content-free description of both sides. */
export function firstDifference(a: Json, b: Json, path = ""): { path: string; before: string; after: string } | undefined {
  if (a === b) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (found) return found;
    }
    return a.length === b.length ? undefined : { path, before: describe(a), after: describe(b) };
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const found = firstDifference((a as Record<string, Json>)[key], (b as Record<string, Json>)[key], `${path}.${key}`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof a === "string" && typeof b === "string") {
    let at = 0;
    while (at < a.length && at < b.length && a[at] === b[at]) at++;
    return { path: `${path}@${at}`, before: describe(a), after: describe(b) };
  }
  return { path, before: describe(a), after: describe(b) };
}

interface Snapshot {
  tools: Json;
  system: Json;
  messages: Json[];
}

/**
 * Where the new request's prefix departs from what the previous request sent:
 * tools, then system, then every message the previous request had.
 */
export function prefixChange(prev: Snapshot, next: Snapshot): { path: string; before: string; after: string } | undefined {
  const tools = firstDifference(prev.tools, next.tools, "tools");
  if (tools) return tools;
  const system = firstDifference(prev.system, next.system, "system");
  if (system) return system;
  for (let i = 0; i < prev.messages.length; i++) {
    if (i >= next.messages.length) return { path: `messages[${i}]`, before: describe(prev.messages[i]), after: "absent" };
    if (fingerprint(prev.messages[i]) === fingerprint(next.messages[i])) continue;
    return firstDifference(prev.messages[i], next.messages[i], `messages[${i}]`);
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_CACHE_TRACE === "0" || Date.now() > TRACE_UNTIL) return;

  // Keyed by model: an in-process call to another model (e.g. a Haiku
  // summarizer) must not be compared against the session's own turns.
  const prev = new Map<string, Snapshot>();
  const prevCached = new Map<string, number>();
  let pending: Record<string, Json> | undefined;
  let seq = 0;

  const write = (record: Record<string, Json>) => {
    if (Date.now() > TRACE_UNTIL) return;
    try {
      const dir = logDir();
      mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch {
      // Tracing must never break a turn.
    }
  };

  pi.on("before_provider_request", (event, ctx) => {
    try {
      const payload = event.payload as { messages?: Json[]; system?: Json; tools?: Json; model?: string; thinking?: Json; output_config?: { effort?: string } };
      // Anthropic-shaped requests only: they carry a top-level system/tools next to messages.
      if (!Array.isArray(payload?.messages) || (payload.system === undefined && payload.tools === undefined)) return;
      if (pending) write(pending); // The previous request never produced a response.
      const next: Snapshot = {
        tools: stripCacheControl(payload.tools ?? null),
        system: stripCacheControl(payload.system ?? null),
        messages: payload.messages.map(stripCacheControl),
      };
      seq += 1;
      const key = String(payload.model);
      const before = prev.get(key);
      pending = {
        t: Date.now(),
        seq,
        pid: process.pid,
        session: ctx.sessionManager?.getSessionId?.(),
        cwd: basename(ctx.cwd),
        provider: ctx.model?.provider,
        model: payload.model,
        tools: fingerprint(next.tools),
        toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
        system: fingerprint(next.system),
        thinking: fingerprint(payload.thinking ?? null),
        effort: payload.output_config?.effort,
        messages: next.messages.length,
        messageHashes: next.messages.map((m) => fingerprint(m).slice(0, 8)),
        change: before ? (prefixChange(before, next) ?? null) : undefined,
      };
      prev.set(key, next);
    } catch {
      pending = undefined;
    }
  });

  pi.on("provider_stream_event", (event) => {
    const data = (event as { data?: Record<string, any> }).data;
    if (!pending || !data) return;
    if (data.type === "message_start" && data.message?.usage) {
      const usage = data.message.usage;
      const read = usage.cache_read_input_tokens ?? 0;
      const cached = read + (usage.cache_creation_input_tokens ?? 0);
      const key = String(pending.model);
      const last = prevCached.get(key);
      Object.assign(pending, {
        read,
        write: usage.cache_creation_input_tokens ?? 0,
        input: usage.input_tokens ?? 0,
        write5m: usage.cache_creation?.ephemeral_5m_input_tokens,
        write1h: usage.cache_creation?.ephemeral_1h_input_tokens,
        responseId: typeof data.message.id === "string" ? data.message.id : undefined,
        miss: last ? read < 0.5 * last : undefined,
      });
      prevCached.set(key, cached);
    }
    if (data.copilot_usage) {
      pending.aiu = data.copilot_usage.total_nano_aiu / 1e9;
      write(pending);
      pending = undefined;
    }
  });

  pi.on("session_start", () => {
    prev.clear();
    prevCached.clear();
    pending = undefined;
  });

  pi.on("message_end", () => {
    // Non-Copilot providers send no copilot_usage: flush once the message is done.
    if (pending && pending.read !== undefined) {
      write(pending);
      pending = undefined;
    }
  });
}
