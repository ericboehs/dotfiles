import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import durableScheduler, {
  parseLeadingFlags,
  tokenize,
} from "../extensions/durable-scheduler.ts";
import { readRegistry, writeRegistry } from "../extensions/lib/task-registry.ts";
import { piArgsFor } from "../extensions/lib/runner.ts";

function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sched-cmd-"));
  const previous = process.env.PI_SCHEDULER_DIR;
  process.env.PI_SCHEDULER_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SCHEDULER_DIR;
    else process.env.PI_SCHEDULER_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function mount() {
  const commands = {};
  const notices = [];
  let registeredTools = 0;

  const ctx = {
    hasUI: true,
    cwd: "/tmp/some-project",
    ui: {
      notify: (message, level = "info") => notices.push({ message, level }),
      confirm: async () => true,
      setStatus: () => {},
    },
  };

  durableScheduler({
    on: () => {},
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: () => { registeredTools += 1; },
  });

  return {
    commands,
    notices,
    registeredTools,
    last: () => notices.at(-1),
    run: (args = "") => commands.schedule.handler(args, ctx),
  };
}

test("tokenize keeps quoted runs together", () => {
  assert.deepEqual(tokenize("--deliver 'slack-noti --urgent' daily 9a"), [
    "--deliver",
    "slack-noti --urgent",
    "daily",
    "9a",
  ]);
  assert.deepEqual(tokenize('--name "kids grades"'), ["--name", "kids grades"]);
  assert.deepEqual(tokenize("   "), []);
});

test("flags are read from the front and stop at the schedule", () => {
  const parsed = parseLeadingFlags("--model cerebras/gpt-oss-120b:low --name grades daily 15:30 :: check grades");
  assert.deepEqual(parsed.flags, { model: "cerebras/gpt-oss-120b:low", name: "grades" });
  assert.equal(parsed.rest, "daily 15:30 :: check grades");
});

test("a flag value containing spaces survives quoting", () => {
  const parsed = parseLeadingFlags(`--deliver 'fnox exec -- slack-noti' daily 9a :: report`);
  assert.equal(parsed.flags.deliver, "fnox exec -- slack-noti");
  assert.equal(parsed.rest, "daily 9a :: report");
});

test("--flag=value is accepted, as is a bare boolean flag", () => {
  assert.deepEqual(parseLeadingFlags("--model=openai/gpt-5 hourly x").flags, { model: "openai/gpt-5" });
  assert.deepEqual(parseLeadingFlags("--tools hourly x").flags, { tools: true });
  assert.deepEqual(parseLeadingFlags("--no-tools hourly x").flags, { "no-tools": true });
});

test("a prompt's own double dash is never mistaken for an option", () => {
  // Flags stop at the first non-flag token, so a cron expression or a prompt
  // that happens to contain "--force" cannot be swallowed as an option.
  const parsed = parseLeadingFlags("cron 0 9 * * 1-5 :: run deploy --force");
  assert.deepEqual(parsed.flags, {});
  assert.equal(parsed.rest, "cron 0 9 * * 1-5 :: run deploy --force");
});

test("an unknown option is refused rather than silently ignored", () => {
  assert.match(parseLeadingFlags("--modle x daily 9a y").error, /Unknown option --modle/);
  assert.match(parseLeadingFlags("--model").error, /--model needs a value/);
});

test("registers /schedule and no LLM tools", () => {
  const ui = mount();
  assert.deepEqual(Object.keys(ui.commands), ["schedule"]);
  assert.equal(ui.registeredTools, 0);
});

test("/schedule writes a durable task with its own model and delivery", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name grades --model cerebras/gpt-oss-120b:low --deliver 'slack-noti' daily 15:30 :: check the kids' grades");

  const [task] = readRegistry().tasks;
  assert.equal(task.name, "grades");
  assert.equal(task.kind, "daily");
  assert.equal(task.dailyAt, "15:30");
  assert.equal(task.model, "cerebras/gpt-oss-120b:low");
  assert.equal(task.deliver, "slack-noti");
  assert.equal(task.prompt, "check the kids' grades");
  assert.equal(task.without, undefined, "a full pi by default, like the one you typed into");
});

test("a task records the directory it was created in", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name here daily 9a :: x");
  assert.equal(readRegistry().tasks[0].cwd, "/tmp/some-project", "project extensions and AGENTS.md should be the ones in mind at creation");
});

test("/schedule reports the catch-up policy it chose, since the Mac sleeps", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("daily 15:30 :: check grades");
  assert.match(ui.last().message, /catch up within 2h/);

  await ui.run("--misfire skip daily 16:30 :: strict");
  assert.match(ui.last().message, /skip if late/);

  await ui.run("--misfire always daily 17:30 :: eventual");
  assert.match(ui.last().message, /always run, however late/);
});

test("/schedule refuses a bad option value instead of storing a default", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--misfire yesterday daily 9a :: x");
  assert.equal(ui.last().level, "error");
  assert.match(ui.last().message, /--misfire wants/);
  assert.deepEqual(readRegistry().tasks, []);

  await ui.run("--timeout soon daily 9a :: x");
  assert.match(ui.last().message, /--timeout wants/);
  assert.deepEqual(readRegistry().tasks, []);
});

test("/schedule refuses a malformed schedule and shows that form's syntax", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("daily 25:00 :: x");
  assert.match(ui.notices.at(-2).message, /Daily syntax/);
  assert.deepEqual(readRegistry().tasks, []);
});

test("names must be unique, because they are how tasks get selected", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name grades daily 15:30 :: first");
  await ui.run("--name grades daily 16:30 :: second");
  assert.equal(ui.last().level, "error");
  assert.match(ui.last().message, /already exists/);
  assert.equal(readRegistry().tasks.length, 1);
});

test("/schedule list is empty until something is scheduled, and names the store", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("list");
  assert.match(ui.last().message, /No durable tasks .*tasks\.json/);

  await ui.run("--name grades daily 15:30 :: check grades");
  await ui.run("list");
  assert.match(ui.last().message, /grades/);
});

test("a paused task is hidden from list but shown by list all", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name grades daily 15:30 :: check grades");
  await ui.run("pause grades");
  assert.match(ui.last().message, /paused/);

  await ui.run("list");
  assert.match(ui.last().message, /No durable tasks/);
  await ui.run("list all");
  assert.match(ui.last().message, /grades/);
});

test("resuming does not replay the slots missed while paused", async (t) => {
  withTempDir(t);
  const ui = mount();
  writeRegistry({
    version: 1,
    tasks: [{
      id: "aaaa1111",
      name: "stale",
      kind: "daily",
      dailyAt: "09:00",
      prompt: "x",
      createdAt: 0,
      nextRunAt: Date.now() - 86_400_000,
      paused: true,
    }],
  });

  await ui.run("resume stale");
  const [task] = readRegistry().tasks;
  assert.equal(task.paused, false);
  assert.ok(task.nextRunAt > Date.now(), "rolled forward rather than fired for every missed day");
});

test("/schedule show explains what the run will actually be", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name grades --model cerebras/gpt-oss-120b:low daily 15:30 :: check grades");
  await ui.run("show grades");
  const shown = ui.last().message;
  assert.match(shown, /schedule\s+daily 15:30/);
  assert.match(shown, /model\s+cerebras\/gpt-oss-120b:low/);
  assert.match(shown, /runs with\s+everything, same as an interactive pi/);
  assert.match(shown, /last run\s+never/);
});

test("a scheduled run gets the same setup as an interactive pi, by default", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name checkin daily 9a :: /checkin");
  const args = piArgsFor(readRegistry().tasks[0]);

  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools"]) {
    assert.ok(!args.includes(flag), `${flag} should not be passed by default`);
  }
  // No TUI to theme, and an unattended daily job should not grow a session file.
  assert.ok(args.includes("--no-themes"));
  assert.ok(args.includes("--no-session"));
});

test("--without strips one piece and leaves the rest of the setup alone", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name summary --without tools daily 9a :: summarize this");
  const task = readRegistry().tasks[0];
  assert.deepEqual(task.without, ["tools"]);

  const args = piArgsFor(task);
  assert.ok(args.includes("--no-tools"), "answer-only, as asked");
  assert.ok(!args.includes("--no-skills"), "everything else is still loaded");

  await ui.run("show summary");
  assert.match(ui.last().message, /runs with\s+everything except tools/);
});

test("--with is an allowlist, so --with none is a bare pi", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name bare --with none daily 9a :: x");
  const args = piArgsFor(readRegistry().tasks[0]);
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools"]) {
    assert.ok(args.includes(flag), `--with none should pass ${flag}`);
  }

  await ui.run("--name narrow --with templates,tools daily 9a :: /checkin");
  const narrow = piArgsFor(readRegistry().tasks.find((task) => task.name === "narrow"));
  assert.ok(!narrow.includes("--no-prompt-templates"));
  assert.ok(!narrow.includes("--no-tools"));
  assert.ok(narrow.includes("--no-skills"), "anything not named is off");

  await ui.run("show narrow");
  assert.match(ui.last().message, /everything except extensions, skills, context/);
});

test("a task written before the default flipped keeps the setup it was given", async (t) => {
  withTempDir(t);
  mount();
  // Old inverted field: an allowlist of what to switch on. Reading it as
  // "nothing disabled" would hand an old task tools it was never given.
  writeRegistry({
    version: 1,
    tasks: [{
      id: "bbbb2222",
      name: "legacy",
      kind: "daily",
      dailyAt: "09:00",
      prompt: "x",
      enable: ["templates"],
      createdAt: 0,
      nextRunAt: Date.now() + 60_000,
    }],
  });

  const args = piArgsFor(readRegistry().tasks[0]);
  assert.ok(args.includes("--no-tools"), "legacy task had no tools and must not gain them");
  assert.ok(args.includes("--no-skills"));
  assert.ok(!args.includes("--no-prompt-templates"), "what it did have is preserved");
});

test("--with all turns everything on, and singular or plural spellings both work", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name everything --with all daily 9a :: x");
  assert.deepEqual(readRegistry().tasks[0].without, [], "nothing switched off");

  await ui.run("--name loose --without skill,TEMPLATE,tools daily 9a :: x");
  assert.deepEqual(
    readRegistry().tasks.find((task) => task.name === "loose").without,
    ["skills", "templates", "tools"],
    "singular and shouty spellings are accepted; nobody should have to guess plurality",
  );

  // Spaces inside the list need quoting, same as --deliver, because the slash
  // command is tokenized on whitespace before flags are read.
  await ui.run("--name spaced --without 'skills, tools' daily 9a :: x");
  assert.deepEqual(
    readRegistry().tasks.find((task) => task.name === "spaced").without,
    ["skills", "tools"],
  );
});

test("show names what is missing, so an inert skill is visible before 9am", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name quiet --without tools,extensions daily 9a :: x");
  await ui.run("show quiet");
  assert.match(ui.last().message, /runs with\s+everything except extensions, tools/);
});

test("a misspelled feature is refused and names the ones that exist", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--without skillz daily 9a :: x");
  assert.equal(ui.last().level, "error");
  assert.match(ui.last().message, /--without does not know "skillz"/);
  assert.match(ui.last().message, /skills/);
  assert.deepEqual(readRegistry().tasks, []);
});

test("/schedule remove takes the task out of the registry", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("--name grades daily 15:30 :: check grades");
  await ui.run("remove grades");
  assert.match(ui.last().message, /Removed grades/);
  assert.deepEqual(readRegistry().tasks, []);
});

test("selecting a task that does not exist is an error, not a silent no-op", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("show nope");
  assert.equal(ui.last().level, "error");
  assert.match(ui.last().message, /No scheduled task matches nope/);
});

test("bare /schedule explains itself and points at the session-scoped commands", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("");
  assert.match(ui.last().message, /use \/once and \/loop/);
  assert.match(ui.last().message, /without an open session/);
  assert.match(ui.last().message, /\/schedule help/, "the terse usage advertises the detailed help");
});

test("/schedule help documents every option the parser accepts", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("help");
  const help = ui.last().message;

  // The usage line lists flag names; help has to say what each one is for, or
  // the flags are undiscoverable. Keep the two from drifting apart.
  for (const flag of ["--name", "--model", "--cwd", "--with", "--without", "--deliver", "--misfire", "--timeout"]) {
    assert.match(help, new RegExp(`${flag}\\b`), `${flag} is undocumented`);
  }
  for (const subcommand of ["list", "show", "runs", "run", "pause", "resume", "remove"]) {
    assert.match(help, new RegExp(`\\b${subcommand}\\b`), `${subcommand} is undocumented`);
  }
});

test("/schedule help explains the choices a caller cannot guess", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("help");
  const help = ui.last().message;

  assert.match(help, /must come before the schedule/, "flag position is not guessable");
  assert.match(help, /skip[\s\S]*always[\s\S]*catch up/, "misfire policies are enumerated");
  assert.match(help, /what an interactive pi would/, "the default is the whole mental model");
  assert.match(help, /answer-only/, "--without tools is the safety valve worth naming");
  assert.match(help, /\/checkin/, "running a prompt template is the non-obvious capability");
  assert.match(help, /stdin/, "deliver is the only way output leaves an unattended run");
  assert.match(help, /default 2h/);
  assert.match(help, /default 15m/);
});

test("help is informational, while misuse is a warning", async (t) => {
  withTempDir(t);
  const ui = mount();

  await ui.run("help");
  assert.equal(ui.last().level, "info");

  await ui.run("");
  assert.equal(ui.last().level, "warning");
});
