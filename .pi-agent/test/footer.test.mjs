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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { VERSION as RUNNING_PI_VERSION } from "@earendil-works/pi-coding-agent";
import footer from "../extensions/footer.ts";

const PORCELAIN = "A  staged.ts\n M edited.ts\n?? new.ts\n";

/** Run one test against a throwaway agent directory (boot log, settings.json). */
function withAgentDir(fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "pi-agent-dir-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

/** Build the extension, drive session_start, and return a rendering handle. */
async function mount(overrides = {}) {
  const {
    model = { id: "claude-opus-5", provider: "github-copilot", reasoning: true },
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
  const guardianRequests = [];
  const eventHandlers = new Map();

  const ctx = {
    hasUI: true,
    cwd: "/Users/someone/Code/github.com/someone/dotfiles",
    model,
    getContextUsage: () => contextUsage,
    modelRegistry: {
      isUsingOAuth: () => overrides.usingOAuth ?? false,
    },
    sessionManager: {
      getBranch: () => costs.map((total) => ({ message: { role: "assistant", usage: { cost: { total } } } })),
    },
    ui: {
      setFooter: (f) => { factory = f; },
      setWidget: (key, content) => { widgets.push({ key, content }); },
      notify: (message, level) => { notices.push({ message, level }); },
    },
  };

  const events = {
    on: (name, handler) => {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    },
    emit: (name, data) => {
      if (
        name === "approval-guardian:set-temporary-bypass" &&
        overrides.guardianEventSupport !== false
      ) {
        guardianRequests.push(data.active);
        data.handled = true;
        events.emit("approval-guardian:temporary-bypass-state", { active: data.active });
        return;
      }
      for (const handler of eventHandlers.get(name) ?? []) handler(data);
    },
  };

  const pi = {
    events,
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

  const previousEntry = process.argv[1];
  const previousExecPath = process.execPath;
  if (overrides.updateInstalled) {
    const root = mkdtempSync(path.join(tmpdir(), "footer-pi-version-"));
    if (overrides.updateInstalled.missingEntry) {
      process.argv[1] = path.join(root, "removed", "dist", "bundle.mjs");
      process.execPath = path.join(root, "bin", "node");
      const pkg = path.join(
        root,
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      );
      mkdirSync(path.dirname(pkg), { recursive: true });
      writeFileSync(pkg, JSON.stringify({ version: overrides.updateInstalled.to }));
    } else {
      const entry = path.join(root, "dist", "cli.js");
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "");
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: overrides.updateInstalled.to }));
      process.argv[1] = entry;
    }
  }
  try {
    footer(pi);
    await pi.handlers.session_start(overrides.sessionStart ?? {}, ctx);
  } finally {
    process.argv[1] = previousEntry;
    process.execPath = previousExecPath;
  }

  const component = factory(
    { requestRender: () => { renders += 1; } },
    { fg: (color, text) => (color === "dim" ? `\x1B[2m${text}\x1B[22m` : text) },
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
    guardianRequests,
    ctx,
    /** Run a registered slash command with the same ctx pi would pass. */
    run: (name, args = "") => pi.commands[name].handler(args, ctx),
    /** Fire the input event, as pi does when something is submitted. */
    input: (event = { source: "interactive", text: "hi" }) => pi.handlers.input(event, ctx),
    startSession: (event = {}) => pi.handlers.session_start(event, ctx),
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
  assert.equal((await ui.settled())[0], "dotfiles gh opus hi master* 41.2k/1m");
});

test("first render omits git and repaints when the refresh lands", async () => {
  const ui = await mount();
  assert.equal(ui.plain()[0], "dotfiles gh opus hi master 41.2k/1m");
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
  assert.equal((await ui.settled())[0], "dotfiles gh opus hi 41.2k/1m");
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
    ["github-copilot", "gh"],
    ["openai-codex", "o"],
    ["openai", "o"],
    ["xai", "x"],
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
    ["gpt-5.6-sol", "sol"],
    ["gpt-5.6-luna", "luna"],
    ["gpt-5.6-terra", "terra"],
    ["claude-opus-5", "opus-5"],
    ["moonshotai/Kimi-K3", "k3"],
    ["deepseek-ai/DeepSeek-V4-Pro-0813", "ds v4-pro"],
    ["deepseek-ai/DeepSeek-V4-Flash-0731", "ds v4-flash"],
    ["zai-org/GLM-5.3-Flash", "oxa"],
    ["z-ai/glm-5.3-flash", "oxa"],
    ["z-ai/glm-5.3-flash@preset/ox-alpha", "oxa"],
    ["glm-5.3-flash", "oxa"],
    ["Qwen3.8-27B-4bit", "3.8-27b"],
    ["Qwen3.6-35B-A3B-UD-MLX-4bit", "3.6-35b-a3b"],
    ["Ornith-1.5-35B-A3B-MLX-4bit", "orn"],
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

test("provider-specific model aliases", async () => {
  for (const [model, expected] of [
    [{ id: "claude-opus-5", provider: "github-copilot", reasoning: true }, "opus"],
    [{ id: "grok-4.6", provider: "xai", reasoning: true }, "grok"],
    [{ id: "glm-5.3-flash", provider: "ollama", reasoning: true }, "oxa"],
  ]) {
    const ui = await mount({ model });
    const rest = ui.plain()[0].split(" ").slice(2).join(" ");
    assert.ok(rest.startsWith(`${expected} `), `${model.provider}/${model.id} -> ${rest}`);
  }
});

test("an OpenRouter route prefixes the model chip, for that model only", async () => {
  const scope = globalThis;
  const previous = scope.__piOpenRouterRoute;
  const model = { id: "z-ai/glm-5.3-flash", provider: "openrouter", reasoning: false };
  try {
    scope.__piOpenRouterRoute = { provider: "Novita", model: "z-ai/glm-5.3-flash", at: Date.now() };
    let ui = await mount({ model });
    assert.equal(ui.plain()[0].split(" ").slice(1, 3).join(" "), "or novita/oxa");

    // A preset resolves server-side: the response names the underlying model.
    ui = await mount({
      model: { id: "z-ai/glm-5.3-flash@preset/ox-alpha", provider: "openrouter", reasoning: false },
    });
    assert.equal(ui.plain()[0].split(" ").slice(1, 3).join(" "), "or novita/oxa");

    // Unmapped providers still read sensibly; mapped ones get the short name.
    scope.__piOpenRouterRoute = { provider: "Z.AI", model: "z-ai/glm-5.3-flash", at: Date.now() };
    ui = await mount({ model });
    assert.equal(ui.plain()[0].split(" ").slice(1, 3).join(" "), "or z/oxa");

    scope.__piOpenRouterRoute = { provider: "Parasail", model: "z-ai/glm-5.3-flash", at: Date.now() };
    ui = await mount({ model });
    assert.equal(ui.plain()[0].split(" ").slice(1, 3).join(" "), "or parasail/oxa");

    // A route recorded for a different model, or a non-OpenRouter provider,
    // must not paint a prefix.
    scope.__piOpenRouterRoute = { provider: "Novita", model: "moonshotai/kimi-k3", at: Date.now() };
    ui = await mount({ model });
    assert.equal(ui.plain()[0].split(" ").slice(1, 3).join(" "), "or oxa");

    scope.__piOpenRouterRoute = { provider: "BaseTen", model: "zai-org/GLM-5.3-Flash", at: Date.now() };
    ui = await mount({ model: { id: "zai-org/GLM-5.3-Flash", provider: "baseten", reasoning: false } });
    assert.equal(ui.plain()[0].split(" ").slice(1, 3).join(" "), "b10 oxa");
  } finally {
    if (previous === undefined) delete scope.__piOpenRouterRoute;
    else scope.__piOpenRouterRoute = previous;
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
    model: { id: "claude-opus-5", provider: "github-copilot", reasoning: false },
  });
  assert.equal(plain.plain()[0].split(" ")[3], "master");
});

test("cost formatting and subscription providers", async () => {
  const billableModel = { id: "gpt-5.4", provider: "openai", reasoning: true };
  const cheap = await mount({ costs: [0.0123], model: billableModel });
  assert.match(cheap.plain()[0], /\$0\.0123$/);

  const pricey = await mount({ costs: [1.5, 2.25], model: billableModel });
  assert.match(pricey.plain()[0], /\$3\.75$/);

  for (const provider of ["openai-codex", "github-copilot"]) {
    const ui = await mount({ model: { id: "claude-opus-5", provider, reasoning: true } });
    assert.doesNotMatch(ui.plain()[0], /\$/, provider);
  }

  const xaiKey = await mount({ model: { id: "grok-4.6", provider: "xai", reasoning: true } });
  assert.match(xaiKey.plain()[0], /\$/, "xAI API keys still have a dollar cost");

  const xaiOAuth = await mount({
    model: { id: "grok-4.6", provider: "xai", reasoning: true },
    usingOAuth: true,
  });
  assert.doesNotMatch(xaiOAuth.plain()[0], /\$/, "SuperGrok OAuth hides cost");
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

test("usage chips color by pace warnings", async () => {
  const shade = async (key, status) => {
    const ui = await mount({ statuses: new Map([[key, status]]) });
    const escaped = status.replaceAll(".", "\\.").replaceAll("!", "\\!");
    return new RegExp(`\x1B\\[(\\d+)m${escaped}\x1B\\[39m`).exec(ui.raw()[0])?.[1];
  };
  for (const key of ["codex-window", "copilot-window", "grok-window"]) {
    assert.equal(await shade(key, "2.1/7D: 18%"), "36", `${key} cyan with no warning`);
    assert.equal(await shade(key, "2.1/7D: 18%!"), "33", `${key} yellow at one !`);
    assert.equal(await shade(key, "2.1/7D: 18%!!"), "31", `${key} red at two !`);
    assert.equal(await shade(key, "2.1/7D: 18%!!!"), "31", `${key} red at three !`);
    assert.equal(await shade(key, "4.8/5H: \u21bb3:45p"), "31", `${key} red at limit reset`);
  }
});

test("unknown context tokens render as ?", async () => {
  const ui = await mount({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } });
  assert.match(ui.plain()[0], /\?\/200k$/);
});

test("session name is right-aligned and statuses split inline vs status row", async () => {
  const ui = await mount({
    sessionName: "footer-work",
    statuses: new Map([
      ["codex-window", "codex 12%"],
      ["copilot-window", "copilot 40%"],
      ["grok-window", "2.1/7D: 18%"],
      ["turn-timer", "3s"],
    ]),
  });
  const [main, statusRow] = await ui.settled(120);
  assert.match(main, /codex 12% copilot 40% 2\.1\/7D: 18% +footer-work$/);
  assert.equal(statusRow, "3s");
  assert.equal(main.length, 120);
});

test("update notice shows both versions in a right-aligned widget above the prompt", async () => {
  // Updates can remove the exact bundle argv[1] names while the old process
  // still runs, so exercise the node-prefix fallback used after /reload.
  const ui = await mount({ updateInstalled: { to: "99.0.0", missingEntry: true } });
  const [main] = await ui.settled(80);
  const widgetFactory = ui.widgets.find(({ key }) => key === "footer-update")?.content;
  const widget = widgetFactory({ requestRender: () => {} });
  const message = `Update installed v${RUNNING_PI_VERSION} → v99.0.0 · Restart to update`;

  assert.equal(main, "dotfiles gh opus hi master* 41.2k/1m");
  assert.equal(strip(widget.render(80)[0]), `${" ".repeat(80 - message.length)}${message}`);
  assert.match(
    widget.render(80)[0],
    new RegExp(`\\x1B\\[32m${message.replaceAll(".", "\\.")}\\x1B\\[39m$`),
  );
});

/**
 * Point HOME at a throwaway dir and register a pi-claude-link peer for this
 * process. Never writes to the real ~/.claude/sessions, which Claude Code reads.
 */
function withPeerRegistry(name) {
  const home = mkdtempSync(path.join(tmpdir(), "footer-home-"));
  if (name !== undefined) {
    mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, name, nameSource: "derived" }),
    );
  }
  const previous = process.env.HOME;
  process.env.HOME = home;
  return () => { process.env.HOME = previous; };
}

test("falls back to the pi-claude-link peer name, dimmed", async () => {
  const restore = withPeerRegistry("pi-dotfiles");
  try {
    const ui = await mount({ sessionName: undefined });
    const [main] = await ui.settled(80);
    assert.match(main, / pi-dotfiles$/);
    assert.equal(main.length, 80);
    // Dim (SGR 2), where a real session name would be cyan.
    assert.match(ui.raw(80)[0], /\x1B\[2mpi-dotfiles\x1B\[22m$/);

    const named = await mount({ sessionName: "footer-work" });
    const [namedLine] = await named.settled(80);
    assert.match(namedLine, / footer-work$/, "an explicit session name wins");
    assert.match(named.raw(80)[0], /\x1B\[36mfooter-work\x1B\[39m$/, "cyan, not dim");
  } finally {
    restore();
  }
});

/**
 * Set the session color /color would have stored, and clear it afterwards.
 * The footer reads it through color.ts, which keeps it on globalThis so it
 * survives /reload.
 */
function withSessionColor(ansi) {
  globalThis.__piSessionColor = { spec: "blue", ansi };
  return () => {
    delete globalThis.__piSessionColor;
  };
}

test("a /color'd session paints its own name to match the editor border", async () => {
  const restore = withSessionColor("\x1B[38;2;95;135;255m");
  try {
    const ui = await mount({ sessionName: "footer-work" });
    await ui.settled(80);
    assert.match(ui.raw(80)[0], /\x1B\[38;2;95;135;255mfooter-work\x1B\[39m$/);
  } finally {
    restore();
  }
});

test("a derived peer name stays dim, session color or not", async () => {
  const restorePeer = withPeerRegistry("pi-dotfiles");
  const restoreColor = withSessionColor("\x1B[38;2;95;135;255m");
  try {
    const ui = await mount({ sessionName: undefined });
    await ui.settled(80);
    // Nobody named this session; coloring it would claim otherwise.
    assert.match(ui.raw(80)[0], /\x1B\[2mpi-dotfiles\x1B\[22m$/);
  } finally {
    restoreColor();
    restorePeer();
  }
});

test("no peer registry means no right-hand segment at all", async () => {
  const restore = withPeerRegistry(undefined);
  try {
    const ui = await mount({ sessionName: undefined });
    const [main] = await ui.settled(80);
    assert.equal(main, "dotfiles gh opus hi master* 41.2k/1m", "no padding, no trailing gap");
  } finally {
    restore();
  }
});

test("a peer name that lands after startup appears without a keystroke", async () => {
  // Registry empty at mount: the first render caches a miss for the whole TTL.
  const restore = withPeerRegistry(undefined);
  try {
    const ui = await mount({ sessionName: undefined });
    await ui.settled(80);
    assert.doesNotMatch(ui.plain(80)[0], /pi-late/);
    const paintsBefore = ui.renderCount();

    // pi-claude-link registers a moment later, as it does in a real session.
    mkdirSync(path.join(process.env.HOME, ".claude", "sessions"), { recursive: true });
    writeFileSync(
      path.join(process.env.HOME, ".claude", "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, name: "pi-late" }),
    );

    await ui.startSession();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(ui.renderCount() > paintsBefore, "repainted on its own");
    assert.match(ui.plain(80)[0], / pi-late$/, "and inside the 5s TTL");
  } finally {
    restore();
  }
});

test("chips wrap whole onto more rows instead of truncating", async () => {
  const ui = await mount({ sessionName: "footer-work" });
  const lines = await ui.settled(30);
  // The session name owns the right end of the first row, so its chips fill
  // only the space left of it; chips that no longer fit move down whole onto
  // a full-width row rather than being cut mid-chip.
  assert.equal(lines[0], "dotfiles gh opus   footer-work");
  assert.equal(lines[1], "hi master* 41.2k/1m");
  assert.ok(lines.every((line) => line.length <= 30), "every row fits the width");
  assert.ok(!lines.join("\n").includes("…"), "nothing is cut");
});

test("a chip wider than the terminal still truncates", async () => {
  const ui = await mount();
  const lines = await ui.settled(6);
  // A chip that can never fit any row is placed alone and truncated — the
  // one case where the ellipsis survives the wrap.
  assert.equal(lines[0], "dotfi…");
  assert.ok(lines.every((line) => line.length <= 6));
});

test("/bypass drives the guardian and shows a bright red marker", async () => {
  const ui = await mount({ statuses: new Map([["codex-window", "codex 12%"]]) });
  assert.doesNotMatch(ui.plain()[0], /bypass/);

  await ui.run("bypass");
  assert.deepEqual(ui.guardianRequests, [true]);
  // Its own second line, left-aligned, so narrow terminals can't truncate it.
  assert.match(ui.plain()[1], /^bypass$/);
  assert.match(ui.raw()[1], /\x1B\[91mbypass\x1B\[39m/, "bright red");

  await ui.run("bypass");
  assert.deepEqual(ui.guardianRequests, [true, false]);
  assert.doesNotMatch(ui.plain().join("\n"), /bypass/);
});

test("/bypass takes explicit on/off and rejects anything else", async () => {
  const ui = await mount();

  await ui.run("bypass", "off");
  assert.deepEqual(ui.guardianRequests, [], "already enabled, nothing to do");
  assert.match(ui.notices.at(-1).message, /already enabled/);

  await ui.run("bypass", "on");
  assert.deepEqual(ui.guardianRequests, [true]);
  await ui.run("bypass", "on");
  assert.equal(ui.guardianRequests.length, 1, "already bypassed, nothing to do");

  await ui.run("bypass", "maybe");
  assert.match(ui.notices.at(-1).message, /Usage: \/bypass/);
  assert.equal(ui.guardianRequests.length, 1);
});

test("/bypass refuses to run without the guardian loaded", async () => {
  const ui = await mount({ commands: [{ name: "footer" }] });
  await ui.run("bypass");
  assert.deepEqual(ui.guardianRequests, [], "must not reach Guardian control");
  assert.equal(ui.notices.at(-1).level, "error");
  assert.doesNotMatch(ui.plain()[0], /bypass/);
});

test("/bypass refuses a guardian without immediate control support", async () => {
  const ui = await mount({ guardianEventSupport: false });
  await ui.run("bypass");
  assert.deepEqual(ui.guardianRequests, []);
  assert.match(ui.notices.at(-1).message, /does not support immediate bypass/);
  assert.equal(ui.notices.at(-1).level, "error");
  assert.doesNotMatch(ui.plain()[0], /bypass/);
});

test("that refusal names the pinned guardian package and its settings file", async () => {
  await withAgentDir(async (dir) => {
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:@nicknisi/pi-stash", "npm:pi-approval-guardian@0.8.0"] }),
    );
    const ui = await mount({ guardianEventSupport: false });
    await ui.run("bypass");
    const { message } = ui.notices.at(-1);
    assert.match(message, /^npm:pi-approval-guardian@0\.8\.0 does not support/);
    assert.match(message, /Pin git:github\.com\/ericboehs\/pi-approval-guardian in /);
    assert.ok(message.includes(path.join(dir, "settings.json")), message);
    assert.match(message, /\/approval-guardian bypass/, "offers the slow path meanwhile");
  });
});

test("that refusal stays generic when settings name no guardian", async () => {
  await withAgentDir(async () => {
    const ui = await mount({ guardianEventSupport: false });
    await ui.run("bypass");
    assert.match(ui.notices.at(-1).message, /^The installed Approval Guardian does not support/);
  });
});

test("bypass clears the guardian's below-editor warning and resets per session", async () => {
  const ui = await mount();
  await ui.run("bypass");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(ui.widgets.at(-1), { key: "approval-guardian-bypass", content: undefined });

  await ui.startSession();
  assert.doesNotMatch(ui.plain()[0], /bypass/);
});

/* ------------------------------------------------------------- boot timing */

const COLD_START = { sessionStart: { reason: "startup" } };

/** Point the extension's boot log at a throwaway directory for one test. */
function withBootLog(fn) {
  return withAgentDir((dir) => fn(path.join(dir, "boot-times.jsonl")));
}

test("a cold start shows the boot time until the first message is sent", async () => {
  await withBootLog(async () => {
    const ui = await mount(COLD_START);
    assert.match(ui.plain()[0], /⚡\d/, "boot time should be on the line at launch");

    const before = ui.renderCount();
    await ui.input();
    assert.equal(ui.renderCount(), before + 1, "clearing it should repaint");
    assert.doesNotMatch(ui.plain()[0], /⚡/);
  });
});

test("only interactive input clears it — commands and /bypass do not", async () => {
  await withBootLog(async () => {
    const ui = await mount(COLD_START);
    ui.plain();

    await ui.run("boot");
    assert.match(ui.plain()[0], /⚡/, "a slash command is not a message");

    await ui.input({ source: "extension", text: "/approval-guardian bypass" });
    assert.match(ui.plain()[0], /⚡/, "messages the footer sends itself do not count");

    await ui.input({ source: "interactive", text: "hi" });
    assert.doesNotMatch(ui.plain()[0], /⚡/);
  });
});

test("a reload reports no boot time, because uptime is not boot time", async () => {
  await withBootLog(async (log) => {
    const ui = await mount({ sessionStart: { reason: "reload" } });
    assert.doesNotMatch(ui.plain()[0], /⚡/);

    await ui.run("boot");
    assert.match(ui.notices.at(-1).message, /boot not measured/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => readFileSync(log, "utf8"), "nothing to log on a reload");
  });
});

test("each cold start appends one record", async () => {
  await withBootLog(async (log) => {
    const ui = await mount(COLD_START);
    ui.plain();
    ui.plain();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "one line per launch, not per render");
    const record = JSON.parse(lines[0]);
    assert.ok(Number.isFinite(record.ms) && record.ms > 0);
    assert.equal(record.cwd, ui.ctx.cwd);
    // Under `node --test`, argv[1] is the test runner rather than pi's bin, so
    // the version lookup degrades to "" instead of throwing. In a real launch
    // it resolves through the symlink to the installed package.
    assert.equal(typeof record.v, "string");
    assert.ok(Number.isFinite(record.load), "load average belongs on every record");
    assert.equal(record.since, undefined, "nothing to measure against on the first record");
  });
});

test("a record measures the gap back to the previous launch", async () => {
  await withBootLog(async (log) => {
    const earlier = new Date(Date.now() - 90_000).toISOString();
    writeFileSync(log, `${JSON.stringify({ t: earlier, ms: 700, v: "", cwd: "" })}\n`);

    const ui = await mount(COLD_START);
    ui.plain();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const record = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    assert.ok(record.since >= 89 && record.since <= 92, `since was ${record.since}`);
  });
});

test("a half-written previous line does not cost the new record its gap", async () => {
  await withBootLog(async (log) => {
    const earlier = new Date(Date.now() - 30_000).toISOString();
    writeFileSync(log, `${JSON.stringify({ t: earlier, ms: 700, v: "", cwd: "" })}\n{"t":"2026-0\n`);

    const ui = await mount(COLD_START);
    ui.plain();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const record = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    assert.ok(record.since >= 29 && record.since <= 32, "should walk back past the torn line");
  });
});

test("/boot stats reports nearest-rank percentiles over the log", async () => {
  await withBootLog(async (log) => {
    const ms = [700, 100, 900, 300, 1000, 500, 200, 800, 400, 600];
    writeFileSync(log, ms.map((value) => JSON.stringify({ t: "", ms: value, v: "", cwd: "" })).join("\n") + "\n");

    // Not a cold start, so the log stays exactly as written.
    const ui = await mount();
    await ui.run("boot", "stats");
    assert.equal(
      ui.notices.at(-1).message,
      "10 launches · p50 500ms · p95 1.00s · min 100ms · max 1.00s",
    );

    await ui.run("boot", "stats 3");
    assert.match(ui.notices.at(-1).message, /^3 launches · p50 600ms/, "should take the last 3 written");
  });
});

test("/boot stats splits relaunch bursts from one-off launches", async () => {
  await withBootLog(async (log) => {
    // A benchmark burst (fast, warm cache) next to real launches (slow). Left
    // undivided these average into a number that describes neither.
    const records = [
      ...[500, 510, 520, 530].map((ms) => ({ ms, since: 5, load: 2 })),
      ...[900, 950, 850].map((ms) => ({ ms, since: 600, load: 8 })),
    ];
    writeFileSync(log, records.map((r) => JSON.stringify({ t: "", v: "", cwd: "", ...r })).join("\n") + "\n");

    const ui = await mount();
    await ui.run("boot", "stats");
    const [summary, cohorts] = ui.notices.at(-1).message.split("\n");
    assert.match(summary, /^7 launches · p50 530ms/);
    assert.equal(
      cohorts,
      "burst <70s (n=4) p50 510ms · min 500ms · max 530ms" +
        " · isolated (n=3) p50 900ms · min 850ms · max 950ms" +
        " · load p50 2.00",
    );
  });
});

test("/boot stats stays one line for records logged before gaps were recorded", async () => {
  await withBootLog(async (log) => {
    writeFileSync(log, [600, 700].map((ms) => JSON.stringify({ t: "", ms, v: "", cwd: "" })).join("\n") + "\n");

    const ui = await mount();
    await ui.run("boot", "stats");
    assert.doesNotMatch(ui.notices.at(-1).message, /\n/, "no cohorts to report, so no second line");
  });
});

test("/boot stats says so when there is nothing recorded", async () => {
  await withBootLog(async () => {
    const ui = await mount();
    await ui.run("boot", "stats");
    assert.equal(ui.notices.at(-1).level, "warning");
    assert.match(ui.notices.at(-1).message, /No boot times recorded/);
  });
});
