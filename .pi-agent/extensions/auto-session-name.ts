/**
 * Auto-name a session after the first turn if the user did not already.
 *
 * `--name` / `/name foo` win, and a resumed session is never re-titled
 * automatically — only a fresh session with no history gets an auto title.
 * `/auto-name` regenerates on demand.
 * Names that look like pi-agent-link's derived peer
 * ids (`pi-dotfiles`, `pi-dotfiles-2`) are treated as unnamed so they still
 * get a real title. One cheap local call (ollama/glm-5.3-flash); override with
 * PI_AUTO_NAME_MODEL=provider/id, disable with PI_AUTO_NAME=0.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NAME_MODEL = process.env.PI_AUTO_NAME_MODEL || "ollama/glm-5.3-flash";

/** True when the name is one the user (or a previous auto-name) chose. */
export function isUserGivenName(name?: string | null): boolean {
  const n = (name || "").trim();
  if (!n) return false;
  if (/^pi-[A-Za-z0-9._-]+(-\d+)?$/.test(n)) return false;
  return true;
}

export function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
}

const INSTRUCTION_ECHO =
  /at-?most-?6-?words|session-?picker|short-?title|coding-?agent-?sessions|the-?user-?wants|plain-?text-?only/i;

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

function pickModel(ctx: ExtensionContext): unknown {
  const reg = ctx.modelRegistry as {
    find?: (provider: string, id: string) => unknown;
    getAvailable?: () => { id?: string }[];
  };
  const slash = NAME_MODEL.indexOf("/");
  if (typeof reg?.find === "function" && slash > 0) {
    const found = reg.find(NAME_MODEL.slice(0, slash), NAME_MODEL.slice(slash + 1));
    if (found) return found;
  }
  const avail = typeof reg?.getAvailable === "function" ? reg.getAvailable() : [];
  return (
    avail.find((m) => /flash|haiku|mini|nano|lite/i.test(String(m?.id || ""))) ||
    ctx.model
  );
}

async function generateTitle(ctx: ExtensionContext, source: string): Promise<string> {
  const picked = pickModel(ctx) as { reasoning?: boolean } | undefined;
  if (!picked || !source.trim()) return "";
  const model = { ...picked, reasoning: false };
  const res = await (
    ctx.modelRegistry as unknown as {
      complete: (
        model: unknown,
        req: { systemPrompt?: string; messages: { role: string; content: string }[] },
        opts: Record<string, unknown>,
      ) => Promise<{ content?: { type?: string; text?: string; thinking?: string }[] }>;
    }
  ).complete(
    model,
    {
      systemPrompt:
        "Reply with only a kebab-case session title: lowercase words joined by hyphens. At most 6 words. No quotes, no period, no markdown. Name the conversation as it is now, not the first message alone.",
      messages: [{ role: "user", content: source.slice(0, 2000) }],
    },
    {
      maxTokens: 24,
      cacheRetention: "none",
      signal: AbortSignal.timeout(20_000),
      sessionId: randomUUID(),
      samplingParams: { enable_thinking: false, thinking: { type: "disabled" } },
    },
  );
  return titleFromContent(res?.content);
}

export default function (pi: ExtensionAPI) {
  let attempted = false;

  async function applyGeneratedName(ctx: ExtensionContext, opts: { force: boolean }): Promise<string> {
    const source = recentContext(ctx.sessionManager.getBranch() || []);
    if (!source) return "";
    const title = await generateTitle(ctx, source);
    if (!title) return "";
    if (!opts.force && isUserGivenName(pi.getSessionName())) return "";
    pi.setSessionName(title);
    return title;
  }

  pi.on("session_start", (_event, ctx) => {
    // A resumed session keeps whatever title it already had; only /auto-name
    // re-titles it. Fresh sessions (new, /new) still get one automatically.
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
      if (!title) attempted = false;
    } catch {
      attempted = false;
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
