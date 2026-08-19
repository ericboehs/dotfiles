import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TICK_MS = 1000;

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem}s`;
}

export default function (pi: ExtensionAPI) {
  let startedAt: number | null = null;
  let turnCount = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let outputTokens = 0;

  const stopTicker = () => {
    if (ticker != null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  pi.on("agent_start", async (_event, ctx) => {
    startedAt = Date.now();
    turnCount = 0;
    outputTokens = 0;
    stopTicker();
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage("Working for 0s...");
      ticker = setInterval(() => {
        if (startedAt == null) return;
        ctx.ui.setWorkingMessage(`Working for ${fmt(Date.now() - startedAt)}...`);
      }, TICK_MS);
    }
  });

  pi.on("turn_start", async () => {
    turnCount += 1;
  });

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message?.role !== "assistant") return;
    const out = (message as { usage?: { output?: number } }).usage?.output;
    if (typeof out === "number") outputTokens += out;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (startedAt == null) return;
    const elapsed = Date.now() - startedAt;
    const turns = turnCount || (event as { messages?: unknown[] }).messages?.length || 1;
    let summary = `⏱ ${fmt(elapsed)} · ${turns} turn${turns === 1 ? "" : "s"}`;
    if (outputTokens > 0) {
      summary += ` · ${outputTokens} tok`;
    }
    stopTicker();
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
      ctx.ui.notify(summary, "info");
    } else {
      process.stderr.write(`${summary}\n`);
    }
    startedAt = null;
  });
}
