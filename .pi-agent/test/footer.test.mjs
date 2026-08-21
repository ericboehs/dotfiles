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
    revList = "0\t0",
    gitCode = 0,
  } = overrides;

  let factory;
  let renders = 0;
  const execCalls = [];
  const sent = [];
  const notices = [];
  const widgets = [];

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
      setWidget: (key, content) => { widgets.push({ key, content }); },
      notify: (message, level) => { notices.push({ message, level }); },
    },
  };

  const pi = {
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      const stdout = args[0] === "rev-list" ? revList : porcelain;
      return { stdout, stderr: "", code: gitCode, killed: false };
    },
    getThinkingLevel: () => overrides.thinkingLevel ?? "high",
    getSessionName: () => sessionName,
    getCommands: () => overrides.commands ?? [{ name: "approval-guardian" }],
    sendUserMessage: (text, options) => { sent.push({ text, options }); },
    registerCommand: (name, options) => { pi.commands[name] = options; },
    on: (name, handler) => { pi.handlers[name] = handler; },
    commands: {},
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
    sent,
    notices,
    widgets,
    ctx,
    /** Run a registered slash command with the same ctx pi would pass. */
    run: (name, args = "") => pi.commands[name].handler(args, ctx),
    startSession: () => pi.handlers.session_start({}, ctx),
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
  assert.equal((await ui.settled())[0], "dotfiles or ox hi master* 41.2k/1m $0.5123");
});

test("first render omits git and repaints when the refresh lands", async () => {
  const ui = await mount();
  assert.equal(ui.plain()[0], "dotfiles or ox hi master 41.2k/1m $0.5123");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ui.renderCount(), 1, "should repaint exactly once when git arrives");
});

test("git runs one porcelain + one rev-list per refresh, cached for 5s", async () => {
  const ui = await mount();
  await ui.settled();
  ui.plain();
  ui.plain();
  assert.equal(ui.execCalls.length, 2);
  assert.deepEqual(ui.execCalls.map((call) => call.args[0]).sort(), ["rev-list", "status"]);
  assert.deepEqual(
    ui.execCalls.find((call) => call.args[0] === "status").args,
    ["status", "--porcelain=v1"],
  );
});

test("non-repo directories drop the git segments", async () => {
  const ui = await mount({ branch: null, gitCode: 128, porcelain: "" });
  assert.equal((await ui.settled())[0], "dotfiles or ox hi 41.2k/1m $0.5123");
});

test("dirty marker: any change earns a single '*' glued to the branch", async () => {
  const cases = [
    ["A  staged.ts\n M edited.ts\n?? new.ts\n", "master*"],
    [" M edited.ts\n M other.ts\n", "master*"],
    ["?? new.ts\n", "master*"],
    ["A  staged.ts\n", "master*"],
    ["UU conflict.ts\n", "master*"],
    ["", "master"],
  ];
  for (const [porcelain, expected] of cases) {
    const ui = await mount({ porcelain });
    const branchSegment = (await ui.settled())[0].split(" ")[4];
    assert.equal(branchSegment, expected, JSON.stringify(porcelain));
  }
});

test("p10k-style arrows, unnumbered, cyan, dropped when in sync", async () => {
  const cases = [
    ["0\t0", "master*"],
    ["0\t2", "master* ⇡"],
    ["3\t0", "master* ⇣"],
    ["3\t2", "master* ⇣⇡"],
    // No upstream / detached HEAD: rev-list prints nothing usable.
    ["", "master*"],
  ];
  for (const [revList, expected] of cases) {
    const ui = await mount({ revList });
    assert.ok((await ui.settled())[0].includes(`${expected} 41.2k`), `${revList} -> ${expected}`);
  }
  // Arrows are cyan (36) while the branch stays magenta (35), as in ~/.p10k.zsh.
  const diverged = await mount({ revList: "3\t2" });
  diverged.raw();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(diverged.raw()[0], /\x1B\[35mmaster\*\x1B\[39m \x1B\[36m⇣⇡\x1B\[39m/);
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

test("/bypass drives the guardian and shows a bright red marker", async () => {
  const ui = await mount({ statuses: new Map([["codex-window", "codex 12%"]]) });
  assert.doesNotMatch(ui.plain()[0], /bypass/);

  await ui.run("bypass");
  assert.deepEqual(ui.sent, [
    { text: "/approval-guardian bypass", options: { expandPromptTemplates: true } },
  ]);
  // Last segment before the flex gap, after cost and the inline statuses.
  assert.match(ui.plain()[0], /\$0\.5123 codex 12% bypass$/);
  assert.match(ui.raw()[0], /\x1B\[91mbypass\x1B\[39m/, "bright red");

  await ui.run("bypass");
  assert.equal(ui.sent.at(-1).text, "/approval-guardian enable");
  assert.doesNotMatch(ui.plain()[0], /bypass/);
});

test("/bypass takes explicit on/off and rejects anything else", async () => {
  const ui = await mount();

  await ui.run("bypass", "off");
  assert.deepEqual(ui.sent, [], "already enabled, nothing to do");
  assert.match(ui.notices.at(-1).message, /already enabled/);

  await ui.run("bypass", "on");
  assert.equal(ui.sent.at(-1).text, "/approval-guardian bypass");
  await ui.run("bypass", "on");
  assert.equal(ui.sent.length, 1, "already bypassed, nothing to do");

  await ui.run("bypass", "maybe");
  assert.match(ui.notices.at(-1).message, /Usage: \/bypass/);
  assert.equal(ui.sent.length, 1);
});

test("/bypass refuses to run without the guardian loaded", async () => {
  const ui = await mount({ commands: [{ name: "footer" }] });
  await ui.run("bypass");
  assert.deepEqual(ui.sent, [], "must not reach the LLM as a plain message");
  assert.equal(ui.notices.at(-1).level, "error");
  assert.doesNotMatch(ui.plain()[0], /bypass/);
});

test("bypass clears the guardian's below-editor warning and resets per session", async () => {
  const ui = await mount();
  await ui.run("bypass");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(ui.widgets.at(-1), { key: "approval-guardian-bypass", content: undefined });

  await ui.startSession();
  assert.doesNotMatch(ui.plain()[0], /bypass/);
});
