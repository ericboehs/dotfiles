import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";

// Real log files, but controlled child exits and a fake clock: no sleeping,
// background processes, or model calls. bg.test.mjs covers real shell execution.
const dir = mkdtempSync(path.join(tmpdir(), "pi-bg-lifecycle-"));
process.env.PI_BG_DIR = path.join(dir, "logs");
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_BG_FG_TIMEOUT = "1";
process.env.PI_BG_TAIL_LINES = "15";
after(() => rmSync(dir, { recursive: true, force: true }));

async function mount(t, { mode = "tui", wake = "followUp" } = {}) {
  // Each wake policy is read at module load; query imports isolate the constants.
  process.env.PI_BG_WAKE = wake;
  const { default: backgroundTasks } = await import(`../extensions/bg.ts?wake=${wake}`);
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });

  const children = [];
  const spawn = t.mock.method(childProcess, "spawn", (_shell, _args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.unref = t.mock.fn();
    const id = options.env.PI_BG_JOB_ID;
    const task = {
      child,
      id,
      logPath: path.join(process.env.PI_BG_DIR, `${id}.log`),
      ended: false,
      exit(code = 0, signal = null) {
        task.ended = true;
        child.emit("exit", code, signal);
      },
    };
    children.push(task);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  // bg.ts uses the named ESM import, so update that live binding too.
  syncBuiltinESMExports();

  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const notices = [];
  const widgets = [];
  const statuses = [];
  const theme = { fg: (_color, text) => text };
  let component;
  let panel;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: dir,
    ui: {
      theme,
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
        component = content?.({ requestRender() {} }, theme);
      },
      setStatus: (...args) => statuses.push(args),
      notify: (message, level) => notices.push({ message, level }),
      custom: (factory) => new Promise((resolve) => {
        panel = factory({ requestRender() {} }, theme, {}, resolve);
      }),
    },
  };
  backgroundTasks({
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerShortcut() {},
    on: (name, handler) => handlers.set(name, handler),
    sendMessage: (message, options) => sent.push({ message, options }),
  });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await handlers.get("session_shutdown")({}, ctx);
  };
  t.after(async () => {
    try {
      for (const task of children) if (!task.ended) task.exit();
      await shutdown();
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  });
  await handlers.get("session_start")({}, ctx);

  const bash = tools.get("bash");
  return {
    bash, children, sent, notices, widgets, statuses, theme, shutdown,
    run: (params) => bash.execute("test-job", params, undefined, undefined, ctx),
    render: (width = 160) => component?.render(width) ?? [],
    component: () => component,
    openPanel: () => commands.get("bg").handler("", ctx),
    panel: () => panel,
  };
}

test("bash no longer advertises a tickler parameter", async (t) => {
  const h = await mount(t);
  assert.equal(Object.hasOwn(h.bash.parameters.properties, "tickler"), false);
  assert.match(h.bash.parameters.properties.background.description, /notifies on completion/);
  assert.deepEqual(h.render(), []);
});

test("above-prompt elapsed times refresh without model wakes; completion still wakes once", async (t) => {
  const h = await mount(t);
  // A legacy call's extra field must not revive periodic model notifications.
  await h.run({ command: "bundle exec rspec", background: true, tickler: 5 });
  const task = h.children[0];
  assert.equal(h.widgets.at(-1).key, "bg");
  assert.deepEqual(h.widgets.at(-1).options, { placement: "aboveEditor" });
  assert.deepEqual(h.render(), ["● 1 background job · rspec 0s · /bg"]);

  t.mock.timers.tick(60_000);
  assert.deepEqual(h.render(), ["● 1 background job · rspec 1m00s · /bg"]);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.statuses, [], "background jobs no longer occupy the footer");

  writeFileSync(task.logPath, "example passed\nall green\n");
  task.exit();
  assert.deepEqual(h.render(), []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "bg");
  assert.equal(h.sent[0].message.display, true);
  assert.deepEqual(h.sent[0].message.details, { id: task.id });
  assert.match(h.sent[0].message.content, /succeeded after 1m00s/);
  assert.match(h.sent[0].message.content, /last 2 lines:\nexample passed\nall green/);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });

  const updates = h.widgets.length;
  t.mock.timers.tick(60_000);
  assert.equal(h.widgets.length, updates, "the UI timer stops when no jobs remain");
  assert.equal(h.sent.length, 1);
});

test("widget bounds width and uses live theme colors", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm run build", background: true });
  const component = h.component();
  h.theme.fg = (_color, text) => `\x1b[36m${text}\x1b[0m`;
  component.invalidate();
  assert.match(component.render(120)[0], /\x1b\[36m/);
  for (const width of [1, 10, 30, 80]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
  }
});

test("widget distinguishes duplicate labels and summarizes overflow", async (t) => {
  const h = await mount(t);
  for (let i = 0; i < 4; i++) await h.run({ command: `node task-${i}.js`, background: true });
  const ids = h.children.map((task) => task.id);
  assert.deepEqual(h.render(), [
    `● 4 background jobs · ${ids[0]} 0s · ${ids[1]} 0s · ${ids[2]} 0s · +1 · /bg`,
  ]);
  h.children[1].exit();
  assert.deepEqual(h.render(), [
    `● 3 background jobs · ${ids[0]} 0s · ${ids[2]} 0s · ${ids[3]} 0s · /bg`,
  ]);
});

test("foreground jobs stay hidden until adopted, then notify on completion", async (t) => {
  const h = await mount(t);
  const pending = h.run({ command: "npm test" });
  await settle(); // Let start() install the foreground-budget timer.
  assert.deepEqual(h.render(), []);
  assert.deepEqual(h.sent, []);

  t.mock.timers.tick(1000);
  const result = await pending;
  assert.match(result.content[0].text, /moved to background/);
  assert.deepEqual(h.render(), ["● 1 background job · test 1s · /bg"]);
  assert.deepEqual(h.sent, []);
  h.children[0].exit();
  assert.deepEqual(h.render(), []);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("foreground completion remains quiet and never displays a running-job widget", async (t) => {
  const h = await mount(t);
  const pending = h.run({ command: "printf done" });
  await settle();
  writeFileSync(h.children[0].logPath, "done");
  h.children[0].exit();
  assert.equal((await pending).content[0].text, "done");
  assert.deepEqual(h.sent, []);
  assert.ok(h.widgets.every(({ content }) => content === undefined));
});

test("failed jobs retain exit-code and log-tail completion notifications", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm test", background: true });
  writeFileSync(h.children[0].logPath, "assertion failed\n");
  h.children[0].exit(23);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /exited 23/);
  assert.match(h.sent[0].message.content, /assertion failed/);
  assert.deepEqual(h.render(), []);
});

test("nextTurn completion delivery remains deferred", async (t) => {
  const h = await mount(t, { wake: "nextTurn" });
  await h.run({ command: "npm test", background: true });
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.sent, []);
  h.children[0].exit();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "nextTurn" });
});

test("PI_BG_WAKE=off still shows the widget but only notifies the UI on completion", async (t) => {
  const h = await mount(t, { wake: "off" });
  await h.run({ command: "npm test", background: true });
  assert.equal(h.render().length, 1);
  h.children[0].exit();
  assert.deepEqual(h.sent, []);
  assert.match(h.notices[0].message, /succeeded/);
  assert.deepEqual(h.render(), []);
});

for (const mode of ["rpc", "print", "json"]) {
  test(`${mode} mode skips the TUI widget but preserves completion delivery`, async (t) => {
    const h = await mount(t, { mode });
    await h.run({ command: "npm test", background: true });
    t.mock.timers.tick(60_000);
    assert.deepEqual(h.widgets, []);
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.sent, []);
    h.children[0].exit();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  });
}

test("stopping a job through /bg still suppresses the model wake", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm test", background: true });
  const task = h.children[0];
  const kill = t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -task.child.pid);
    assert.equal(signal, "SIGTERM");
    task.exit(null, signal);
    return true;
  });
  const opened = h.openPanel();
  h.panel().handleInput("x");
  h.panel().handleInput("\x1b");
  await opened;
  t.mock.timers.tick(5000);
  assert.equal(kill.mock.callCount(), 1);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.render(), []);
  assert.match(h.notices[0].message, /killed \(SIGTERM\)/);
});

test("shutdown clears the widget and stops UI updates without killing detached jobs", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm test", background: true });
  await h.shutdown();
  assert.deepEqual(h.render(), []);
  const updates = h.widgets.length;
  t.mock.timers.tick(60_000);
  assert.equal(h.widgets.length, updates);
  assert.equal(h.children[0].ended, false);
  assert.match(h.notices[0].message, /bg job\(s\) still running/);
});
