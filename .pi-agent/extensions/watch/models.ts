/**
 * watch/models.ts — which models may read which text. Shared by watch.ts and
 * meeting.ts. Not an extension: pi loads only top-level files and folders with
 * an index.ts.
 *
 * Work text (VA Slack, Outlook, Teams, calendar alerts, meetings) goes only to
 * VA Copilot, the github-copilot provider. When no VA Copilot model answers,
 * code rules decide; work text never falls back to a personal model. Personal
 * text goes to the flat-subscription models.
 */

/** Providers allowed to read work text. */
export const WORK_PROVIDERS: readonly string[] = ["github-copilot"];
/** The work scout: fast, on VA Copilot. */
export const WORK_MODELS: readonly string[] = ["github-copilot/claude-haiku-5.5"];
/** Meeting research when the session model is not on VA Copilot. */
export const WORK_RESEARCH_MODEL = "github-copilot/claude-opus-5.5";
/** The personal scout: flat-subscription models first; pay-per-token ones only by explicit opt-in. */
export const PERSONAL_MODELS: readonly string[] = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"];

/** VA Copilot caps prompts at 100k tokens; each scout call stays well under. */
export const PROMPT_MAX_TOKENS = 60_000;
/** Rough and on the high side (~3 chars a token), so a fitted prompt never trips the cap. */
export const estTokens = (text: string) => Math.ceil(text.length / 3);

/** "a/b, c/d" → ["a/b", "c/d"]; anything without a provider is ignored. */
export const modelSpecs = (raw: string | undefined) => (raw ?? "").split(/[\s,]+/).filter((s) => s.includes("/"));

export const isWorkModel = (spec: string) => WORK_PROVIDERS.includes(spec.slice(0, spec.indexOf("/")).toLowerCase());

/** Specs that may read work text, and the ones refused (to report, never to use). */
export function workOnly(specs: readonly string[]): { ok: string[]; refused: string[] } {
	return { ok: specs.filter(isWorkModel), refused: specs.filter((s) => !isWorkModel(s)) };
}
