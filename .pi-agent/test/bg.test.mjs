import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// bg.ts reads these once at module load. Keep the foreground budget short for
// the real-process smoke tests and suppress completion turns from adopted jobs.
// 0.2s assumed ~20ms fork/exec, but observed spawn latency on this box is
// ~250ms even for /usr/bin/true under load, which flaked the budget, so
// "short" now means 0.5s.
process.env.PI_BG_DIR = mkdtempSync(path.join(tmpdir(), "pi-bg-test-"));
process.env.PI_BG_FG_TIMEOUT = "1";
process.env.PI_BG_MAX_TIMEOUT = "0.5";
process.env.PI_BG_WAKE = "off";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-agent-bg-test-"));
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ shellCommandPrefix: "export PI_BG_TEST_PREFIX=present" }),
);

const { default: backgroundTasks } = await import("../extensions/bg.ts");

function mount() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (name, handler) => handlers.set(name, handler),
    sendMessage: () => {},
    events: { on: () => () => {}, emit: () => {} },
  };
  backgroundTasks(pi);

  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "test", id: "test" },
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "bg-test",
      getSessionFile: () => undefined,
    },
  };

  return { bash: tools.get("bash"), ctx, handlers };
}

function textOf(result) {
  return result.content.map((part) => part.text ?? "").join("\n");
}

test("documents hard explicit timeouts", () => {
  const { bash } = mount();
  assert.match(bash.description, /commands without a timeout auto-background/);
  assert.match(bash.description, /explicit timeout is killed/);
  assert.match(bash.description, /maximum 0\.5s/);
  assert.equal(
    bash.parameters.properties.timeout.description,
    "Hard deadline in seconds (optional, maximum 0.5)",
  );
});

test("explicit-timeout commands retain the configured shell prefix", async () => {
  const { bash, ctx } = mount();
  const result = await bash.execute(
    "explicit-timeout-prefix",
    { command: 'printf "$PI_BG_TEST_PREFIX"', timeout: 1 },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(textOf(result), "present");
});

test("an explicit timeout is clamped and kills instead of auto-backgrounding", async () => {
  const { bash, ctx } = mount();
  await assert.rejects(
    bash.execute(
      "explicit-timeout",
      { command: 'node -e "setTimeout(() => {}, 1000)"', timeout: 20 },
      undefined,
      undefined,
      ctx,
    ),
    /Command timed out after 0\.5 seconds/,
  );
});

test("a command without a timeout auto-backgrounds after the foreground budget", async () => {
  const { bash, ctx } = mount();
  const result = await bash.execute(
    "implicit-timeout",
    { command: 'node -e "setTimeout(() => {}, 1200)"' },
    undefined,
    undefined,
    ctx,
  );

  assert.match(textOf(result), /Still running after 1s — moved to background as job [0-9a-f]{6}/);
});

// Codemode scripts receive structuredContent, not text. `...base` keeps the
// built-in bash outputSchema, so the foreground path must honor it.
test("a foreground command returns the built-in structured result for scripts", async () => {
  const { bash, ctx } = mount();
  const result = await bash.execute("structured-ok", { command: "echo hi" }, undefined, undefined, ctx);

  assert.ok(bash.outputSchema, "keeps the built-in outputSchema");
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.output, "hi\n");
  assert.equal(result.structuredContent.truncated, false);
  assert.equal(result.structuredContent.exit_code, 0);
  assert.equal(typeof result.structuredContent.wall_time_seconds, "number");
  assert.equal("full_output_path" in result.structuredContent, false);
});

test("a nonzero exit is an error for the model but still carries the exit code", async () => {
  const { bash, ctx } = mount();
  const result = await bash.execute("structured-fail", { command: "echo nope; exit 3" }, undefined, undefined, ctx);

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Command exited with code 3/);
  assert.equal(result.structuredContent.output, "nope\n");
  assert.equal(result.structuredContent.exit_code, 3);
});

test("structured output over 1 MiB keeps head and tail and points at the log", async () => {
  const { bash, ctx } = mount();
  const result = await bash.execute(
    "structured-big",
    { command: "printf 'H'; head -c 1200000 /dev/zero | tr '\\0' x; printf 'T'" },
    undefined,
    undefined,
    ctx,
  );
  const out = result.structuredContent.output;

  assert.equal(result.structuredContent.truncated, true);
  assert.ok(out.startsWith("H") && out.endsWith("T"));
  assert.match(out, /\[\.\.\. \d+ bytes omitted \.\.\.\]/);
  assert.ok(Buffer.byteLength(out) < 1024 * 1024 + 100);
  assert.match(result.structuredContent.full_output_path, /\.log$/);
});
