// Component benchmark, NOT a full TUI boot benchmark. No real sessions,
// credentials, live settings, network or LLM calls. Run from anywhere:
//   node .pi-agent/test/window-mode.bench.mjs
//   node .pi-agent/test/window-mode.bench.mjs --schemas | python3 -c '...'
import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Pi is already initialized before loading extensions. Exclude its SDK/module
// graph from extension-only numbers instead of misattributing it to window mode.
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const importStart = performance.now();
const { default: windowMode, preferencePath } = await import("../extensions/window-mode/index.ts");
const importMs = performance.now() - importStart;
const dir = await mkdtemp(join(tmpdir(), "pi-window-bench-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

function mount(sm, opted = true) {
  const handlers = new Map(), tools = [];
  let active = ["read", "bash"];
  const pi = {
    on: (name, fn) => handlers.set(name, fn), registerCommand: () => {},
    registerTool: (t) => { tools.push(t); active.push(t.name); },
    getActiveTools: () => active, setActiveTools: (names) => { active = names; },
  };
  const ctx = { sessionManager: sm, model: { provider: "bench", id: opted ? "enabled" : "disabled" },
    hasUI: false, getContextUsage: () => ({ tokens: 1000, contextWindow: 128000 }) };
  windowMode(pi);
  return { tools, fire: (event, value = {}) => handlers.get(event)?.(value, ctx) };
}
function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return { p50_ms: +sorted[Math.floor(sorted.length * .5)].toFixed(3), p95_ms: +sorted[Math.floor(sorted.length * .95)].toFixed(3) };
}
try {
  const pref = preferencePath("bench/enabled");
  await mkdir(dirname(pref), { recursive: true });
  await writeFile(pref, JSON.stringify({ version: 1, model: "bench/enabled", enabled: true }));
  const boot = { enabled: [], disabled: [] };
  const noHistoryAccess = { getLeafEntry() { throw new Error("Startup must not inspect history"); } };
  for (let i = 0; i < 100; i++) {
    // Interleave enabled/disabled cases to avoid drift from machine load.
    for (const opted of i % 2 ? [false, true] : [true, false]) {
      const start = performance.now();
      const m = mount(noHistoryAccess, opted);
      await m.fire("session_start");
      boot[opted ? "enabled" : "disabled"].push(performance.now() - start);
    }
  }
  const sm = SessionManager.inMemory(dir);
  const fresh = mount(sm);
  await fresh.fire("session_start");
  const firstStart = performance.now();
  await fresh.fire("before_agent_start", { systemPrompt: "Base." });
  const firstRequestMs = performance.now() - firstStart;
  const { GUIDANCE, recall } = await import("../extensions/window-mode/runtime.ts");
  const schema = fresh.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  if (process.argv.includes("--schemas")) {
    console.log(JSON.stringify({ guidance: GUIDANCE, tools: schema }));
  } else {
    // Large resume's extension-only traversal/search, separated from fresh boot.
    // Pi's JSONL parsing and base context rebuilding are intentionally excluded.
    for (let i = 0; i < 10_000; i++) sm.appendMessage({ role: "user", content: `Message ${i}: synthetic history.`, timestamp: Date.now() });
    const resumed = mount(sm);
    await resumed.fire("session_start");
    const resumeStart = performance.now();
    await resumed.fire("before_agent_start", { systemPrompt: "Base." });
    const resumeRequestMs = performance.now() - resumeStart;
    const searchStart = performance.now();
    await recall(sm.getBranch(), { query: "no-match-worst-case" });
    const searchMs = performance.now() - searchStart;
    console.log(JSON.stringify({
      note: "Component timings only; not total Pi/TUI boot. SDK preloaded; disk cache warm. No real LLM evaluation.",
      coldEntryImport_ms: +importMs.toFixed(3),
      registrationAndSessionStart: { disabled: stats(boot.disabled), enabled: stats(boot.enabled) },
      firstEnabledRequestLazyLoad_ms: +firstRequestMs.toFixed(3),
      resume10000EntriesExtensionOnly_ms: +resumeRequestMs.toFixed(3),
      search10000EntriesWorstCase_ms: +searchMs.toFixed(3),
      serializedGuidanceAndSchemaChars: GUIDANCE.length + JSON.stringify(schema).length,
    }, null, 2));
  }
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(dir, { recursive: true, force: true });
}
