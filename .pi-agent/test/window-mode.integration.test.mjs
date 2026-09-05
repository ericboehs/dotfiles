import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import windowMode, { preferencePath } from "../extensions/window-mode/index.ts";

const STATE = `## Goal
Implement parser without changing public API.
## Constraints
Support Ruby 3.3. Preserve the return type.
## Progress
Comma splitting failed quoted inputs. Tokenizer tests pass.
## Decisions
Use a state machine and preserve the public adapter.
## Next
Test escaped quotes and run the full suite.`;
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

// Real Pi loader, AgentSession, extension runner, tool persistence, compaction
// and continuation. Only the LLM is scripted. No real credentials or network.
async function fixture(fn, sessionOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-window-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 2_000 },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [windowMode], systemPromptOverride: () => "Synthetic integration test.",
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "no-auth.json"), modelsPath: join(dir, "no-models.json"),
      modelsStorePath: join(dir, "model-store.json"), allowModelNetwork: false,
    });
    // Runtime-only placeholder; never sent to a service or written to disk.
    await modelRuntime.setRuntimeApiKey("openai", "unit-test-not-a-real-credential");
    const base = modelRuntime.getModel("openai", "gpt-4o");
    assert.ok(base);
    const model = { ...base, contextWindow: 128_000 };
    const file = preferencePath("openai/gpt-4o");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, model: "openai/gpt-4o", enabled: true }));
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime, model, thinkingLevel: "off", settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), ...sessionOptions,
    }));
    await session.bindExtensions({ mode: "print" });
    return await fn(session);
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function response(model, content, stopReason, tokens) {
  const message = { role: "assistant", content, api: model.api, provider: model.provider,
    model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: tokens, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 50, cost } };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      yield { type: "done", reason: stopReason, message };
    },
    result: async () => message,
  };
}

test("real agent auto-rolls over after checkpoint tool batch and resumes without summarization", { timeout: 30_000 }, () => fixture(async (session) => {
  const requests = [];
  const events = [];
  session.subscribe((event) => events.push(event));
  // Several older turns give Pi a valid default cut point before our hook runs.
  for (let i = 0; i < 10; i++) {
    session.sessionManager.appendMessage({ role: "user", content: `Older turn ${i}: ` + "background ".repeat(300), timestamp: Date.now() });
  }
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  session.agent.streamFunction = (model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    assert.ok(requests.length <= 2, "rollover must not add a summarizer/model call");
    if (requests.length === 1) {
      assert.ok(context.tools.some((tool) => tool.name === "context_checkpoint"), "lazy tool appears on first actual request");
      assert.match(context.systemPrompt, /Window mode/);
      return response(model, [{ type: "toolCall", id: "save-note", name: "context_checkpoint", arguments: { state: STATE } }], "toolUse", 115_000);
    }
    assert.match(JSON.stringify(context.messages), /Window checkpoint/);
    assert.match(JSON.stringify(context.messages), /Comma splitting failed/);
    assert.ok(!JSON.stringify(context.messages).includes("synthetic original prompt"));
    return response(model, [{ type: "text", text: "Continued successfully after rollover." }], "stop", 2_000);
  };
  await session.prompt("synthetic original prompt");
  assert.equal(requests.length, 2, JSON.stringify(events.filter((e) => e.type === "message_end" || e.type === "compaction_end")));
  const compaction = session.sessionManager.getBranch().find((e) => e.type === "compaction");
  assert.equal(compaction?.details?.kind, "window-mode/v1", JSON.stringify({ window: session.model.contextWindow,
    settings: session.settingsManager.getCompactionSettings(), events: events.map((e) => e.type),
    errors: session.messages.filter((m) => m.errorMessage).map((m) => m.errorMessage.slice(0, 200)) }));
  assert.equal(compaction.fromHook, true);
  assert.ok(events.some((e) => e.type === "compaction_end" && e.result?.details?.kind === "window-mode/v1"));
  assert.ok(!events.some((e) => e.type === "tool_execution_end" && e.isError));
}));

test("explicit tool exclusions win over per-model opt-in", { timeout: 30_000 }, () => fixture(async (session) => {
  let names;
  session.agent.streamFunction = (model, context) => {
    names = context.tools.map((tool) => tool.name);
    return response(model, [{ type: "text", text: "No tools needed." }], "stop", 1_000);
  };
  await session.prompt("Test explicit tool exclusions.");
  assert.ok(names && !names.includes("context_checkpoint"));
}, { excludeTools: ["context_checkpoint"] }));

test("real agent without a checkpoint delegates to Pi's ordinary summarizer", { timeout: 30_000 }, () => fixture(async (session) => {
  let summaries = 0;
  session.agent.streamFunction = (model, context) => {
    // This call is invoked by explicit /compact, not the main conversation.
    summaries++;
    assert.match(JSON.stringify(context), /summar/i);
    return response(model, [{ type: "text", text: "## Goal\nPreserve Ruby 3.3 compatibility.\n## Next Steps\nRun the test suite." }], "stop", 1000);
  };
  session.sessionManager.appendMessage({ role: "user", content: "Preserve Ruby 3.3 compatibility.", timestamp: Date.now() });
  session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier work ".repeat(2000) }],
    api: session.model.api, provider: session.model.provider, model: session.model.id, stopReason: "stop",
    timestamp: Date.now(), usage: { input: 50_000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 50_050, cost } });
  session.sessionManager.appendMessage({ role: "user", content: "Now run the suite.", timestamp: Date.now() });
  const result = await session.compact();
  assert.ok(summaries >= 1);
  assert.match(result.summary, /Ruby 3.3/);
  assert.notEqual(result.details?.kind, "window-mode/v1");
}));
