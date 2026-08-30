/**
 * End-of-run toast and a rolling log of how models actually spend your time.
 *
 * The headline is steps/task (pi turns), not seconds/step. Grok/sol feel faster
 * because they loop less, not because each loop is snappier — a 30s-think + 3
 * step finish beats 8s/step × 21 steps. Seconds/step is the diagnostic sitting
 * next to the count; wall time is what you felt.
 *
 * A "run" is agent_start (if idle) → agent_settled, so compaction retries stay
 * one toast. Steps are attributed to the model on each turn_end message, so a
 * mid-run /model switch splits the count instead of pinning the whole wait on
 * whoever finished. Thinking level is recorded per step the same way, so
 * opus-high and opus-off don't share a p50. Mixed runs (model or level) show
 * the split and are excluded from p50: opus gets the hard refactors, grok the
 * one-liners, and averaging them together is how you lie to yourself.
 *
 * Guardian blocks are sniffed from the rejection text pi stores on the blocked
 * toolResult (see pi-approval-guardian's rejectionReason). No import, so a
 * missing guardian still launches.
 *
 * Thinking is split out of output: `usage.reasoning` is a subset of `output`
 * when the provider reports it. If it doesn't, we estimate from thinking-block
 * characters (~4 chars/token) and mark it with ~. Streamed thinking_start/end
 * events give wall time; hidden-reasoning models that never emit those blocks
 * still show tokens when the provider reports them, not a fake TTFT "think".
 *
 * Each settled run is appended to turn-stats.jsonl. `/turn stats` is `/boot
 * stats` for models: 14-day p50 steps/time per model+thinking, median not mean.
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageUpdateEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

const TICK_MS = 1_000;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const LOG_FILE = "turn-stats.jsonl";
const LOG_KEEP = 1_000;
const LOG_MAX_BYTES = 400_000;

/** Distinctive phrases from pi-approval-guardian's rejectionReason(). */
const GUARDIAN_BLOCK_RE =
  /This action was rejected due to unacceptable risk|Automatic permission review|Repeated adverse automatic-review/;

/** Ordered rewrite rules for verbose model ids; first match wins. Lowercased. */
const MODEL_RULES: Array<[RegExp, string]> = [
  [/^stealth\/ox-alpha$/i, "ox"],
  [/^gpt-[\d.]+-sol$/i, "sol"],
  [/^claude-(.+)$/i, "$1"],
  [/^moonshotai\/Kimi-(.+)$/i, "$1"],
  [/^deepseek-ai\/DeepSeek-(V\d+)-([A-Za-z]+)(?:-\d+)?$/i, "DS $1-$2"],
  [/^z-ai\/GLM-5\.3-Flash$/i, "oxa"],
  [/^zai-org\/GLM-5\.3-Flash$/i, "oxa"],
  [/^Ornith-1\.5-35B-A3B-MLX-4bit$/i, "orn-1.5"],
  [/^Qwen([\d.]+-\d+B(?:-A\d+B)?)\b.*$/i, "$1"],
];

/** Short names for thinking levels (pi: off|minimal|low|medium|high|xhigh|max). */
const THINKING_NAMES: Record<string, string> = {
  minimal: "min",
  low: "lo",
  medium: "med",
  high: "hi",
  xhigh: "xhi",
};

interface ModelSlice {
  model: string;
  thinking: string;
  steps: number;
  tools: number;
  thinkTok: number;
  thinkMs: number;
}

interface TurnRecord {
  t: string;
  ms: number;
  steps: number;
  tools: number;
  blocked: number;
  tok: number;
  thinkTok: number;
  thinkMs: number;
  thinkEst: boolean;
  models: ModelSlice[];
}

interface RunState {
  startedAt: number;
  steps: number;
  tools: number;
  blocked: number;
  tok: number;
  thinkTok: number;
  thinkMs: number;
  thinkEst: boolean;
  thinkOpenAt: number | null;
  thinkMsTurn: number;
  models: Map<string, ModelSlice>;
  closed: boolean;
}

export default function (pi: ExtensionAPI) {
  let run: RunState | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const stopTicker = () => {
    if (ticker != null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const startTicker = (ctx: ExtensionContext) => {
    stopTicker();
    if (!ctx.hasUI || !run) return;
    ctx.ui.setWorkingMessage(workingMessage(run));
    ticker = setInterval(() => {
      if (!run) return;
      ctx.ui.setWorkingMessage(workingMessage(run));
    }, TICK_MS);
  };

  pi.on("agent_start", async (_event, ctx) => {
    // Compaction retry is a new agent_start on the same wait; keep accumulating.
    if (run && !run.closed) return;
    run = {
      startedAt: Date.now(),
      steps: 0,
      tools: 0,
      blocked: 0,
      tok: 0,
      thinkTok: 0,
      thinkMs: 0,
      thinkEst: false,
      thinkOpenAt: null,
      thinkMsTurn: 0,
      models: new Map(),
      closed: false,
    };
    startTicker(ctx);
  });

  pi.on("turn_start", async () => {
    if (!run || run.closed) return;
    closeThink(run);
    run.thinkMs += run.thinkMsTurn;
    run.thinkMsTurn = 0;
  });

  pi.on("message_update", async (event: MessageUpdateEvent) => {
    if (!run || run.closed) return;
    const kind = event.assistantMessageEvent?.type;
    if (kind === "thinking_start") {
      if (run.thinkOpenAt == null) run.thinkOpenAt = Date.now();
    } else if (kind === "thinking_end") {
      closeThink(run);
    }
  });

  pi.on("turn_end", async (event: TurnEndEvent) => {
    if (!run || run.closed) return;
    const message = event.message;
    if (message.role !== "assistant") return;
    closeThink(run);
    const thinking = shortThinking(pi.getThinkingLevel());
    const key = sliceKey(modelKey(message.provider, message.model), thinking);
    const toolCount = event.toolResults.length;
    const blocked = event.toolResults.filter((result) => isGuardianBlock(result)).length;
    const out = message.usage?.output;
    const think = thinkingTokens(message);
    const thinkMs = run.thinkMsTurn;
    run.thinkMsTurn = 0;

    run.steps += 1;
    run.tools += toolCount;
    run.blocked += blocked;
    if (typeof out === "number") run.tok += out;
    run.thinkTok += think.tok;
    run.thinkMs += thinkMs;
    if (think.estimated && think.tok > 0) run.thinkEst = true;

    const slice = run.models.get(key) ?? {
      model: modelKey(message.provider, message.model),
      thinking,
      steps: 0,
      tools: 0,
      thinkTok: 0,
      thinkMs: 0,
    };
    slice.steps += 1;
    slice.tools += toolCount;
    slice.thinkTok += think.tok;
    slice.thinkMs += thinkMs;
    run.models.set(key, slice);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await finish(ctx);
  });

  // Quit mid-run still happened; don't lose the partial.
  pi.on("session_shutdown", async (_event, ctx) => {
    await finish(ctx);
  });

  pi.registerCommand("turn", {
    description: "Show 14-day per-model/thinking step/time stats, or /turn stats [n]",
    getArgumentCompletions: (prefix: string) => {
      const items = [{ value: "stats", label: "stats" }];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim();
      const statsArgs = /^stats\b/.test(argument) ? argument.slice("stats".length).trim() : argument;
      const requested = Number.parseInt(statsArgs, 10);
      const limit = Number.isFinite(requested) && requested > 0 ? requested : undefined;
      await showStats(ctx, limit);
    },
  });

  async function finish(ctx: ExtensionContext): Promise<void> {
    const current = run;
    if (!current || current.closed) return;
    current.closed = true;
    run = null;
    const elapsed = Date.now() - current.startedAt;
    const record = toRecord(current, elapsed);
    stopTicker();
    if (ctx.hasUI) ctx.ui.setWorkingMessage();

    // Skip a start/abort that never reached the model.
    if (record.steps === 0 && elapsed < 2_000) return;

    const summary = formatSummary(record);
    if (ctx.hasUI) {
      ctx.ui.notify(summary, "info");
    } else {
      process.stderr.write(`${summary}\n`);
    }
    void recordTurn(record).catch(() => {});
  }
}

function workingMessage(run: RunState): string {
  const elapsed = fmt(Date.now() - run.startedAt);
  const parts = [`Working for ${elapsed}`];
  if (run.steps > 0) {
    parts.push(`${run.steps} step${run.steps === 1 ? "" : "s"}`);
  }
  const thinkMs = liveThinkMs(run);
  if (thinkMs >= 1_000) parts.push(`${fmt(thinkMs)} think`);
  const line = `${parts.join(" · ")}...`;
  if (run.blocked === 0) return line;
  const noun = run.blocked === 1 ? "tool call" : "tool calls";
  // Indent to sit under the message, past the spinner cell.
  return `${line}\n  ${run.blocked} ${noun} blocked`;
}

function liveThinkMs(run: RunState): number {
  const open = run.thinkOpenAt == null ? 0 : Date.now() - run.thinkOpenAt;
  return run.thinkMs + run.thinkMsTurn + open;
}

function closeThink(run: RunState): void {
  if (run.thinkOpenAt == null) return;
  run.thinkMsTurn += Date.now() - run.thinkOpenAt;
  run.thinkOpenAt = null;
}

function toRecord(run: RunState, ms: number): TurnRecord {
  closeThink(run);
  return {
    t: new Date().toISOString(),
    ms,
    steps: run.steps,
    tools: run.tools,
    blocked: run.blocked,
    tok: run.tok,
    thinkTok: run.thinkTok,
    thinkMs: run.thinkMs + run.thinkMsTurn,
    thinkEst: run.thinkEst,
    models: [...run.models.values()],
  };
}

export function formatSummary(record: TurnRecord): string {
  const elapsed =
    record.thinkMs >= 1_000
      ? `${fmt(record.ms)} (${fmt(record.thinkMs)} think)`
      : fmt(record.ms);
  const clock = `⏱ ${formatFinishedTime(record.t)}: ${elapsed}`;
  const parts = [clock];
  if (record.steps > 0) parts.push(`${fmtRate(record.ms / record.steps)}/step`);
  parts.push(`${record.steps} step${record.steps === 1 ? "" : "s"}`);
  if (record.models.length > 1) {
    parts[2] += ` (${formatSplit(record.models)})`;
  }
  if (record.tools > 0) parts.push(`${record.tools} tool${record.tools === 1 ? "" : "s"}`);
  const tokPart = formatThinkTokens(record);
  if (tokPart) parts.push(tokPart);
  let summary = parts.join(" · ");
  if (record.blocked > 0) {
    const noun = record.blocked === 1 ? "tool call" : "tool calls";
    summary += `\nGuardian blocked ${record.blocked} ${noun}`;
  }
  return summary;
}

function formatSplit(models: readonly ModelSlice[]): string {
  return models.map((slice) => `${sliceLabel(slice)} ${slice.steps}`).join(" + ");
}

async function showStats(
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info" | "warning") => void } },
  limit: number | undefined,
): Promise<void> {
  let records: TurnRecord[] = [];
  try {
    records = await readTurns();
  } catch {
    // No log yet.
  }
  if (limit !== undefined) {
    records = records.slice(-limit);
  } else {
    const windowStart = Date.now() - WINDOW_MS;
    records = records.filter((entry) => Date.parse(entry.t) >= windowStart);
  }
  if (records.length === 0) {
    ctx.ui.notify("No turn stats recorded yet", "warning");
    return;
  }

  const mixed = records.filter((entry) => entry.models.length !== 1);
  const single = records.filter((entry) => entry.models.length === 1);
  const byModel = new Map<string, TurnRecord[]>();
  for (const entry of single) {
    const slice = entry.models[0];
    if (!slice) continue;
    const key = sliceKey(slice.model, slice.thinking);
    const list = byModel.get(key) ?? [];
    list.push(entry);
    byModel.set(key, list);
  }

  const ranked = [...byModel.entries()].sort((a, b) => b[1].length - a[1].length);
  const labels = new Map(ranked.map(([key, entries]) => [key, sliceLabel(entries[0]?.models[0])]));
  const nameWidth = Math.max(4, ...[...labels.values()].map((label) => label.length));
  const windowLabel = limit !== undefined ? `last ${records.length}` : "14d";
  const lines = [
    `${windowLabel} · ${single.length} single-model run${single.length === 1 ? "" : "s"}` +
      (mixed.length > 0 ? ` · ${mixed.length} mixed excluded from p50` : ""),
  ];
  for (const [key, entries] of ranked) {
    const steps = percentile(
      entries.map((entry) => entry.steps).sort((a, b) => a - b),
      50,
    );
    const ms = percentile(
      entries.map((entry) => entry.ms).sort((a, b) => a - b),
      50,
    );
    const rate = steps > 0 ? `${fmtRate(ms / steps)}/step` : "";
    const thinkShares = entries
      .filter((entry) => entry.tok > 0 && entry.thinkTok > 0)
      .map((entry) => entry.thinkTok / entry.tok)
      .sort((a, b) => a - b);
    const thinkPct =
      thinkShares.length > 0 ? `${Math.round(percentile(thinkShares, 50) * 100)}% think` : "";
    const blocked = entries.reduce((sum, entry) => sum + entry.blocked, 0);
    const row =
      `${pad(labels.get(key) ?? key, nameWidth)}  ${steps} steps · ${fmt(ms)}` +
      (rate ? ` · ${rate}` : "") +
      (thinkPct ? ` · ${thinkPct}` : "") +
      `   n=${entries.length}` +
      (blocked > 0 ? `  (${blocked} blocked)` : "");
    lines.push(row);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function logPath(): string {
  return join(agentDir(), LOG_FILE);
}

async function recordTurn(record: TurnRecord): Promise<void> {
  const file = logPath();
  const existing = await readFile(file, "utf8").catch(() => "");
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(file, line);
  if (existing.length + line.length <= LOG_MAX_BYTES) return;
  const kept = [...existing.split("\n").filter(Boolean), line.trimEnd()].slice(-LOG_KEEP);
  await writeFile(file, `${kept.join("\n")}\n`);
}

async function readTurns(): Promise<TurnRecord[]> {
  const out: TurnRecord[] = [];
  for (const line of (await readFile(logPath(), "utf8")).split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<TurnRecord>;
      if (typeof parsed.t !== "string" || typeof parsed.ms !== "number") continue;
      if (!Number.isFinite(parsed.ms) || !Array.isArray(parsed.models)) continue;
      out.push({
        t: parsed.t,
        ms: parsed.ms,
        steps: num(parsed.steps),
        tools: num(parsed.tools),
        blocked: num(parsed.blocked),
        tok: num(parsed.tok),
        thinkTok: num(parsed.thinkTok),
        thinkMs: num(parsed.thinkMs),
        thinkEst: parsed.thinkEst === true,
        models: parsed.models.filter(isSlice).map((slice) => ({
          model: slice.model,
          thinking: typeof slice.thinking === "string" ? slice.thinking : "",
          steps: num(slice.steps),
          tools: num(slice.tools),
          thinkTok: num(slice.thinkTok),
          thinkMs: num(slice.thinkMs),
        })),
      });
    } catch {
      // Half-written line from a racing process.
    }
  }
  return out;
}

/** Total generated tokens, with reasoning as a subset — never a second pile. */
function formatThinkTokens(record: TurnRecord): string | undefined {
  if (record.tok <= 0 && record.thinkTok <= 0) return undefined;
  if (record.thinkTok <= 0) return `${formatCount(record.tok)} tok`;
  const reason = `${record.thinkEst ? "~" : ""}${formatCount(record.thinkTok)} reason`;
  if (record.tok <= 0) return reason;
  return `${formatCount(record.tok)} tok (${reason})`;
}

function thinkingTokens(message: {
  content?: unknown;
  usage?: { output?: number; reasoning?: number };
}): { tok: number; estimated: boolean } {
  const reported = message.usage?.reasoning;
  if (typeof reported === "number") return { tok: Math.max(0, reported), estimated: false };
  const chars = thinkingChars(message.content);
  if (chars === 0) return { tok: 0, estimated: false };
  const est = Math.max(1, Math.round(chars / 4));
  const out = message.usage?.output;
  return {
    tok: typeof out === "number" && out > 0 ? Math.min(est, out) : est,
    estimated: true,
  };
}

function thinkingChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: unknown; thinking?: unknown };
    if (item.type === "thinking" && typeof item.thinking === "string") {
      chars += item.thinking.length;
    }
  }
  return chars;
}

function isSlice(value: unknown): value is ModelSlice {
  if (!value || typeof value !== "object") return false;
  const slice = value as ModelSlice;
  return typeof slice.model === "string" && typeof slice.steps === "number";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelKey(provider: string | undefined, model: string | undefined): string {
  if (provider && model) return `${provider}/${model}`;
  if (model) return model;
  return "unknown";
}

function shortModelId(key: string): string {
  const id = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  for (const [pattern, replacement] of MODEL_RULES) {
    if (pattern.test(id)) return id.replace(pattern, replacement).toLowerCase();
  }
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

function shortThinking(level: string): string {
  return THINKING_NAMES[level] ?? level;
}

function sliceKey(model: string, thinking: string): string {
  return thinking ? `${model}\t${thinking}` : model;
}

function sliceLabel(slice: ModelSlice | undefined): string {
  if (!slice) return "unknown";
  const name = shortModelId(slice.model);
  return slice.thinking ? `${name} ${slice.thinking}` : name;
}

function isGuardianBlock(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const entry = result as { isError?: unknown; content?: unknown };
  if (entry.isError !== true) return false;
  return GUARDIAN_BLOCK_RE.test(textOf(entry.content));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as { type?: unknown; text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

export function formatFinishedTime(timestamp: string): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const hour = hours % 12 || 12;
  const minute = date.getMinutes().toString().padStart(2, "0");
  return `${hour}:${minute}${hours < 12 ? "a" : "p"}`;
}

function fmt(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem}s`;
}

function fmtRate(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = ms / 1_000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${s.toFixed(0)}s`;
  return fmt(ms);
}

function formatCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 100_000) return `${trimFixed(value / 1_000, 1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${trimFixed(value / 1_000_000, 1)}m`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}
