import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// bg.ts reads these once at module load. Keep the foreground budget short for
// the real-process smoke tests and suppress completion turns from adopted jobs.
process.env.PI_BG_DIR = mkdtempSync(path.join(tmpdir(), "pi-bg-test-"));
process.env.PI_BG_FG_TIMEOUT = "1";
process.env.PI_BG_MAX_TIMEOUT = "0.2";
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
  assert.match(bash.description, /maximum 0\.2s/);
  assert.equal(
    bash.parameters.properties.timeout.description,
    "Hard deadline in seconds (optional, maximum 0.2)",
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
    /Command timed out after 0\.2 seconds/,
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
