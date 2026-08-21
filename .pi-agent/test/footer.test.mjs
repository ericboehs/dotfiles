/**
 * Smoke tests for the footer extension.
 *
 * Runs the real extension against stub pi/ctx objects, so it also proves the
 * file loads under Node's type stripping — which is how pi itself loads it.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import footer from "../extensions/footer.ts";

const PORCELAIN = "A  staged.ts\n M edited.ts\n?? new.ts\n";

/** Build the extension, drive session_start, and return a rendering handle. */
async function mount(overrides = {}) {
  const {
    model = { id: "stealth/ox-alpha", provider: "openrouter", reasoning: true },
    contextUsage = { tokens: 41234, contextWindow: 1000000, percent: 4 },
    branch = "master",
    sessionName = undefined,
    statuses = new Map(),
    costs = [0.0123, 0.5],
    porcelain = PORCELAIN,
    gitCode = 0,
  } = overrides;

  let factory;
  let renders = 0;
  const execCalls = [];

  const ctx = {
    hasUI: true,
    cwd: "/Users/someone/Code/github.com/someone/dotfiles",
    model,
    getContextUsage: () => contextUsage,
    sessionManager: {
      getBranch: () => costs.map((total) => ({ message: { role: "assistant", usage: { cost: { total } } } })),
    },
    ui: {
      setFooter: (f) => { factory = f; },
      notify: () => {},
    },
  };

  const pi = {
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return { stdout: porcelain, stderr: "", code: gitCode, killed: false };
    },
    getThinkingLevel: () => overrides.thinkingLevel ?? "high",
    getSessionName: () => sessionName,
    registerCommand: () => {},
    on: (name, handler) => { pi.handlers[name] = handler; },
    handlers: {},
  };

  footer(pi);
  await pi.handlers.session_start({}, ctx);

  const component = factory(
    { requestRender: () => { renders += 1; } },
    { fg: (_color, text) => text },
    {
      getGitBranch: () => branch,
      getExtensionStatuses: () => statuses,
      onBranchChange: () => () => {},
    },
  );

  return {
    component,
    execCalls,
    renderCount: () => renders,
    /** Render once with ANSI stripped. */
    plain: (width = 120) => component.render(width).map(strip),
    /** Render once, keeping ANSI. */
    raw: (width = 120) => component.render(width),
    /** Render, let the async git refresh land, then render again. */
    settled: async (width = 120) => {
      component.render(width);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return component.render(width).map(strip);
    },
  };
}

function strip(text) {
  return text.replace(new RegExp(String.raw`\x1B\[[0-9;]*m`, "g"), "");
}

test("renders the full line once git has settled", async () => {
  const ui = await mount();
  assert.equal(
    (await ui.settled())[0],
    "dotfiles or ox hi master +1 ±1 ?1 41.2k/1m $0.5123",
  );
});

test("first render omits git and repaints when the refresh lands", async () => {
  const ui = await mount();
  assert.equal(ui.plain()[0], "dotfiles or ox hi master 41.2k/1m $0.5123");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ui.renderCount(), 1, "should repaint exactly once when git arrives");
});

test("git runs a single porcelain call and caches it for 5s", async () => {
  const ui = await mount();
  await ui.settled();
  ui.plain();
  ui.plain();
  assert.equal(ui.execCalls.length, 1);
  assert.deepEqual(ui.execCalls[0].args, ["status", "--porcelain=v1"]);
});

test("non-repo directories drop the git segments", async () => {
  const ui = await mount({ branch: null, gitCode: 128, porcelain: "" });
  assert.equal((await ui.settled())[0], "dotfiles or ox hi 41.2k/1m $0.5123");
});

test("zero counts are omitted, and a clean tree drops the status segment", async () => {
  const cases = [
    ["A  staged.ts\n M edited.ts\n?? new.ts\n", "master +1 ±1 ?1 41.2k"],
    [" M edited.ts\n M other.ts\n", "master ±2 41.2k"],
    ["?? new.ts\n", "master ?1 41.2k"],
    ["A  staged.ts\n", "master +1 41.2k"],
    ["MM both.ts\n", "master +1 ±1 41.2k"],
    ["", "master 41.2k"],
  ];
  for (const [porcelain, expected] of cases) {
    const ui = await mount({ porcelain });
    assert.match((await ui.settled())[0], new RegExp(expected.replace(/[+?]/g, "\\$&")), porcelain);
  }
});

test("provider aliases", async () => {
  const cases = [
    ["openrouter", "or"],
    ["github-copilot", "copilot"],
    ["openai-codex", "oai"],
    ["baseten", "b10"],
    ["omlx", "omlx"],
  ];
  for (const [provider, expected] of cases) {
    const ui = await mount({ model: { id: "x", provider, reasoning: false } });
    assert.equal(ui.plain()[0].split(" ")[1], expected, provider);
  }
});

test("model aliases are lowercased, unknown ids pass through", async () => {
  const cases = [
    ["stealth/ox-alpha", "ox"],
    ["gpt-5.6-sol", "sol"],
    ["claude-opus-5", "opus-5"],
    ["moonshotai/Kimi-K3", "k3"],
    ["deepseek-ai/DeepSeek-V4-Pro-0813", "ds v4-pro"],
    ["deepseek-ai/DeepSeek-V4-Flash-0731", "ds v4-flash"],
    ["Qwen3.8-27B-4bit", "3.8-27b"],
    ["Qwen3.6-35B-A3B-UD-MLX-4bit", "3.6-35b-a3b"],
    ["gpt-5.2-codex", "gpt-5.2-codex"],
    ["GLM-4.6", "GLM-4.6"],
  ];
  for (const [id, expected] of cases) {
    const ui = await mount({ model: { id, provider: "omlx", reasoning: false } });
    // "dir provider model ..." — the alias may contain a space ("ds v4-pro").
    const rest = ui.plain()[0].split(" ").slice(2).join(" ");
    assert.ok(rest.startsWith(`${expected} `), `${id} -> ${rest}`);
  }
});

test("thinking levels are abbreviated, and hidden for non-reasoning models", async () => {
  const cases = [
    ["off", "off"],
    ["minimal", "min"],
    ["low", "lo"],
    ["medium", "med"],
    ["high", "hi"],
    ["xhigh", "xhi"],
    ["max", "max"],
  ];
  for (const [level, expected] of cases) {
    const ui = await mount({ thinkingLevel: level });
    assert.equal(ui.plain()[0].split(" ")[3], expected, level);
  }
  const plain = await mount({
    model: { id: "stealth/ox-alpha", provider: "openrouter", reasoning: false },
  });
  assert.equal(plain.plain()[0].split(" ")[3], "master");
});

test("cost formatting and subscription providers", async () => {
  const cheap = await mount({ costs: [0.0123] });
  assert.match(cheap.plain()[0], /\$0\.0123$/);

  const pricey = await mount({ costs: [1.5, 2.25] });
  assert.match(pricey.plain()[0], /\$3\.75$/);

  for (const provider of ["openai-codex", "github-copilot"]) {
    const ui = await mount({ model: { id: "claude-opus-5", provider, reasoning: true } });
    assert.doesNotMatch(ui.plain()[0], /\$/, provider);
  }
});

test("context colors escalate at 70% and 90%", async () => {
  const shade = async (tokens) => {
    const ui = await mount({ contextUsage: { tokens, contextWindow: 100, percent: 0 } });
    // The context-length segment is the colored run immediately before the "/".
    return /\x1B\[(\d+)m[^\x1B]+\x1B\[39m\//.exec(ui.raw()[0])?.[1];
  };
  assert.equal(await shade(10), "36", "cyan under 70%");
  assert.equal(await shade(75), "33", "yellow at 70%");
  assert.equal(await shade(95), "31", "red at 90%");
});

test("unknown context tokens render as ?", async () => {
  const ui = await mount({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } });
  assert.match(ui.plain()[0], /\?\/200k /);
});

test("session name is right-aligned and statuses split inline vs status row", async () => {
  const ui = await mount({
    sessionName: "footer-work",
    statuses: new Map([
      ["codex-window", "codex 12%"],
      ["copilot-window", "copilot 40%"],
      ["turn-timer", "3s"],
    ]),
  });
  const [main, statusRow] = await ui.settled(120);
  assert.match(main, /codex 12% copilot 40% +footer-work$/);
  assert.equal(statusRow, "3s");
  assert.equal(main.length, 120);
});

test("long lines are truncated to the width", async () => {
  const ui = await mount({ sessionName: "footer-work" });
  const [main] = await ui.settled(30);
  assert.equal(main.length, 30);
  assert.ok(main.endsWith("…"));
});
