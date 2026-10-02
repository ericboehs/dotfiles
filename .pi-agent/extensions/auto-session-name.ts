/**
 * Auto-name a session after the first turn if the user did not already.
 *
 * `--name` / `/name foo` win, and a resumed session is never re-titled
 * automatically — only a fresh session with no history gets an auto title.
 * `/auto-name` regenerates on demand.
 * Names that look like pi-agent-link's derived peer
 * ids (`pi-dotfiles`, `pi-dotfiles-2`) are treated as unnamed so they still
 * get a real title. One cheap flash-model call, trying DEFAULT_NAME_MODELS in
 * order until one answers (a 402/quota error just falls through to the next);
 * override with PI_AUTO_NAME_MODEL=provider/id[,provider/id...], disable with
 * PI_AUTO_NAME=0.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Opencode Go models only: they're covered by the flat subscription, unlike
 * the pay-per-token providers (inco, baseten). deepseek-v4.1-flash is verified;
 * the rest are fallbacks. Ollama Cloud's glm-5.3-flash used to lead this list
 * but now 402s on the free tier.
 */
export const DEFAULT_NAME_MODELS = [
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.3-flash",
  "opencode-go/qwen3.8-flash",
];
/** Give up auto-naming a session after this many failed attempts. */
const MAX_AUTO_FAILURES = 3;

/** `provider/id` specs from a comma/space separated env value. */
export function parseModelList(raw?: string | null): string[] {
  const specs = (raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.indexOf("/") > 0);
  return specs.length ? specs : DEFAULT_NAME_MODELS;
}

/** One short line from a provider error like `402: {"message":"..."}`. */
export function summarizeError(raw?: string | null): string {
  const text = String(raw || "unknown error").trim();
  const m = text.match(/^(\d{3}):\s*(\{.*\})\s*$/s);
  let out = text;
  if (m) {
    try {
      const body = JSON.parse(m[2]!) as { message?: string; error?: { message?: string } };
      const msg = body?.message || body?.error?.message;
      if (msg) out = `${m[1]} ${msg}`;
    } catch {
      // keep the raw text
    }
  }
  out = out.replace(/\s*\(ref: [^)]*\)/, "").replace(/\s+/g, " ");
  return out.length > 90 ? `${out.slice(0, 89)}…` : out;
}
/** Session titles stay this short so they fit tabs, footers, and pickers. */
const MAX_NAME_CHARS = 20;

/** True when the name is one the user (or a previous auto-name) chose. */
export function isUserGivenName(name?: string | null): boolean {
  const n = (name || "").trim();
  if (!n) return false;
  if (/^pi-[A-Za-z0-9._-]+(-\d+)?$/.test(n)) return false;
  return true;
}

export function sanitizeName(raw: string): string {
  const words = raw
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6);
  // Whole words only: stop before the word that would exceed the cap, so a
  // tab never shows a clipped fragment. A single over-long first word still
  // hard-truncates rather than leaving the session unnamed.
  let name = "";
  for (const word of words) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > MAX_NAME_CHARS) break;
    name = next;
  }
  if (!name && words.length > 0) name = words[0]!.slice(0, MAX_NAME_CHARS);
  return name;
}

const INSTRUCTION_ECHO =
  /at-?most-?\d+-?(short-?)?words|session-?picker|short-?title|coding-?agent-?sessions|the-?user-?wants|plain-?text-?only/i;

/** Keep final answer text only — drop thinking blocks and instruction echo. */
export function titleFromContent(
  content: { type?: string; text?: string; thinking?: string }[] | undefined,
): string {
  const raw = (content || [])
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text as string)
    .join(" ");
  const first = sanitizeName(raw.split(/\n/)[0] || "");
  if (!first || INSTRUCTION_ECHO.test(first)) return "";
  return first;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string; text?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text)
    .join(" ")
    .trim();
}

/** Newest user + assistant turns, capped, for a rename from recent context. */
export function recentContext(branch: unknown[], maxChars = 2000): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = branch.length - 1; i >= 0 && used < maxChars; i--) {
    const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const t = messageText(entry.message?.content);
    if (!t) continue;
    if (t.startsWith("[cross-agent") || t.startsWith("[reply from")) continue;
    const chunk = `${role}: ${t.slice(0, 400)}`;
    parts.unshift(chunk);
    used += chunk.length;
  }
  return parts.join("\n\n").slice(-maxChars);
}

/** True once the transcript holds a real exchange (i.e. this is a resume). */
export function hasHistory(branch: unknown[]): boolean {
  return (branch || []).some((e) => {
    const entry = e as { type?: string; message?: { role?: string } };
    return entry?.type === "message" && entry.message?.role === "assistant";
  });
}

type NameModel = { provider?: string; id?: string; reasoning?: boolean };
type CompleteResult = {
  stopReason?: string;
  errorMessage?: string;
  content?: { type?: string; text?: string; thinking?: string }[];
};
type NamingRegistry = {
  find?: (provider: string, id: string) => NameModel | undefined;
  hasConfiguredAuth?: (model: NameModel) => boolean;
  complete?: (
    model: NameModel,
    req: { systemPrompt?: string; messages: { role: string; content: string }[] },
    opts: Record<string, unknown>,
  ) => Promise<CompleteResult>;
};
/** Remembers which model last produced a title so later calls start there. */
export type NamerState = { preferred?: string };

const modelKey = (m: NameModel) => `${m.provider}/${m.id}`;

/**
 * Configured naming models with credentials, preferred first. No generic
 * fallback (any "flash" model, the session model): that could silently land
 * on a pay-per-token provider.
 */
export function candidateModels(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  specs: string[],
  state: NamerState = {},
): NameModel[] {
  const reg = ctx.modelRegistry as unknown as NamingRegistry;
  const hasAuth = (m: NameModel) =>
    typeof reg?.hasConfiguredAuth === "function" ? reg.hasConfiguredAuth(m) : true;
  const out: NameModel[] = [];
  const add = (m?: NameModel) => {
    if (!m || !hasAuth(m) || out.some((o) => modelKey(o) === modelKey(m))) return;
    out.push(m);
  };
  for (const spec of specs) {
    const slash = spec.indexOf("/");
    if (slash > 0 && typeof reg?.find === "function") {
      add(reg.find(spec.slice(0, slash), spec.slice(slash + 1)));
    }
  }
  const i = state.preferred ? out.findIndex((m) => modelKey(m) === state.preferred) : -1;
  if (i > 0) out.unshift(...out.splice(i, 1));
  return out;
}

/**
 * Ask each candidate in turn for a title. Provider errors (stopReason "error",
 * e.g. Ollama's 402 free-tier refusal) come back as results, not throws, so
 * they are checked explicitly. Throws with every model's reason if none work.
 */
export async function generateTitle(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  source: string,
  state: NamerState = {},
  specs: string[] = parseModelList(process.env.PI_AUTO_NAME_MODEL),
): Promise<string> {
  if (!source.trim()) return "";
  const reg = ctx.modelRegistry as unknown as NamingRegistry;
  if (typeof reg?.complete !== "function") throw new Error("modelRegistry.complete unavailable");
  const candidates = candidateModels(ctx, specs, state);
  if (!candidates.length) throw new Error("no naming model with credentials");
  const errors: string[] = [];
  for (const model of candidates) {
    try {
      // Pass the model unchanged: for reasoning models pi sends the model's
      // thinking-off value (e.g. reasoning_effort "none"); forcing
      // reasoning:false suppressed that and let thinking eat the budget.
      const res = await reg.complete(
        model,
        {
          systemPrompt:
            "Reply with only a kebab-case session title: lowercase words joined by hyphens. At most 3 short words, under 20 characters total. No quotes, no period, no markdown. Name the conversation as it is now, not the first message alone.",
          messages: [{ role: "user", content: source.slice(0, 2000) }],
        },
        {
          maxTokens: 64,
          cacheRetention: "none",
          signal: AbortSignal.timeout(15_000),
          sessionId: randomUUID(),
          samplingParams: { enable_thinking: false, thinking: { type: "disabled" } },
        },
      );
      if (res?.stopReason === "error" || res?.stopReason === "aborted") {
        errors.push(`${modelKey(model)}: ${summarizeError(res.errorMessage || res.stopReason)}`);
        continue;
      }
      const title = titleFromContent(res?.content);
      if (title) {
        state.preferred = modelKey(model);
        return title;
      }
      errors.push(`${modelKey(model)}: no usable title (${res?.stopReason || "empty"})`);
    } catch (e) {
      errors.push(`${modelKey(model)}: ${summarizeError((e as Error)?.message)}`);
    }
  }
  throw new Error(errors.join("; "));
}

export default function (pi: ExtensionAPI) {
  let attempted = false;
  let failures = 0;
  const namer: NamerState = {};

  async function applyGeneratedName(ctx: ExtensionContext, opts: { force: boolean }): Promise<string> {
    const source = recentContext(ctx.sessionManager.getBranch() || []);
    if (!source) return "";
    const title = await generateTitle(ctx, source, namer);
    if (!title) return "";
    if (!opts.force && isUserGivenName(pi.getSessionName())) return "";
    pi.setSessionName(title);
    return title;
  }

  pi.on("session_start", (_event, ctx) => {
    // A resumed session keeps whatever title it already had; only /auto-name
    // re-titles it. Fresh sessions (new, /new) still get one automatically.
    failures = 0;
    attempted =
      isUserGivenName(pi.getSessionName()) ||
      hasHistory(ctx.sessionManager.getBranch() || []);
  });

  pi.on("session_info_changed", (event) => {
    const name = (event as { name?: string })?.name ?? pi.getSessionName();
    if (isUserGivenName(name)) attempted = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (process.env.PI_AUTO_NAME === "0") return;
    if (attempted || isUserGivenName(pi.getSessionName())) {
      attempted = true;
      return;
    }
    attempted = true;
    try {
      const title = await applyGeneratedName(ctx, { force: false });
      if (title) failures = 0;
      else attempted = false;
    } catch (e) {
      // Retry on later turns, but stop hammering providers that keep refusing.
      failures += 1;
      attempted = failures >= MAX_AUTO_FAILURES;
      if (attempted && ctx.hasUI) {
        ctx.ui.notify(`auto-name gave up: ${(e as Error).message}`, "warning");
      }
    }
  });

  pi.registerCommand("auto-name", {
    description: "Generate a kebab-case session title from recent context",
    handler: async (_args, ctx) => {
      ctx.ui.notify("naming…", "info");
      try {
        const title = await applyGeneratedName(ctx, { force: true });
        ctx.ui.notify(title ? `named ${title}` : "could not generate a name", title ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(`naming failed: ${(e as Error).message}`, "error");
      }
    },
  });
}
