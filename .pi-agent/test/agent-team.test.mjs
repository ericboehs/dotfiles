/**
 * Checks for the agent team: agents/*.md (builder-a, builder-b, adversary),
 * read by extensions/subagent.ts, and the prompt templates that drive them
 * (team, adversary-gate, retro).
 *
 * Agent discovery runs through the real subagent tool against a temporary
 * agent directory whose agents/ holds one symlink per file, the way the
 * symlink-each link in mise.toml lays it out. Nothing spawns a child pi.
 *
 *   bin/pi-ext-check                 # typecheck + all tests
 *   node --test .pi-agent/test/agent-team.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const piAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(piAgent, "agents");
const promptsDir = path.join(piAgent, "prompts");
const TEAM = ["adversary", "builder-a", "builder-b"];
const TEAM_PROMPTS = ["adversary-gate", "retro", "team"];
const PI_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-agent-team-test-"));
mkdirSync(path.join(agentDir, "agents"));
for (const name of readdirSync(agentsDir)) symlinkSync(path.join(agentsDir, name), path.join(agentDir, "agents", name));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SUBAGENT_CHILD;

const { default: subagent } = await import("../extensions/subagent.ts");
const { parseFrontmatter } = await import("@earendil-works/pi-coding-agent");

const read = (file) => readFileSync(file, "utf8");
const agent = (name) => parseFrontmatter(read(path.join(agentsDir, `${name}.md`)));
const prompt = (name) => parseFrontmatter(read(path.join(promptsDir, `${name}.md`)));
const toolsOf = (name) => agent(name).frontmatter.tools.split(",");

function mount() {
  let tool;
  let bgListener;
  subagent({
    registerTool: (definition) => (tool = definition),
    on: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    events: { on: () => () => {}, emit: (channel, data) => channel === "bg:start" && bgListener?.(data) },
  });
  const ctx = { cwd: mkdtempSync(path.join(tmpdir(), "pi-agent-team-cwd-")), model: undefined };
  return {
    run: (params) => tool.execute("test-call", params, undefined, undefined, ctx),
    onBgStart: (listener) => (bgListener = listener),
  };
}

const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("the subagent tool finds all three roles through symlinked agent files", async () => {
  const listed = textOf(await mount().run({})).match(/Agents: (.*)\./)?.[1].split(", ") ?? [];
  for (const name of [...TEAM, "scout", "worker"]) assert.ok(listed.includes(name), `${name} is listed: ${listed}`);
});

test("each role's name matches its file and it carries a description", () => {
  const files = readdirSync(agentsDir);
  for (const name of TEAM) assert.ok(files.includes(`${name}.md`), `${name}.md exists`);
  for (const name of TEAM) {
    const { frontmatter, body } = agent(name);
    assert.equal(frontmatter.name, name);
    assert.ok(frontmatter.description?.length > 20, `${name} has a description`);
    assert.ok(body.trim().length > 200, `${name} has a prompt`);
  }
});

test("tools are pi built-ins with no spaces, since the list goes straight to --tools", () => {
  for (const name of TEAM) {
    const raw = agent(name).frontmatter.tools;
    assert.doesNotMatch(raw, /\s/, `${name} tools: ${raw}`);
    for (const t of raw.split(",")) assert.ok(PI_TOOLS.has(t), `${name} names unknown tool ${t}`);
  }
});

test("builders can edit, and the adversary has no edit or write tool", () => {
  for (const name of ["builder-a", "builder-b"]) {
    assert.ok(toolsOf(name).includes("edit") && toolsOf(name).includes("write"), name);
  }
  assert.ok(!toolsOf("adversary").includes("edit"));
  assert.ok(!toolsOf("adversary").includes("write"));
});

test("the adversary's child command carries its read-only tool list and its prompt", async () => {
  const h = mount();
  let command;
  h.onBgStart((r) => {
    r.accepted = true;
    command = r.command;
    r.reply({ id: "abc123", logPath: "/tmp/x.log" });
  });
  await h.run({ agent: "adversary", task: "Gate: done", background: true });
  assert.ok(command.includes("'--tools' 'read,grep,find,ls,bash'"), command.slice(0, 400));
  assert.match(command, /You are the adversary on a team of three agents/);
});

test("builders refuse to work without an owned folder and never call a task done", () => {
  for (const name of ["builder-a", "builder-b"]) {
    const { body } = agent(name);
    assert.match(body, /`Owned folder:`/);
    assert.match(body, /If the task does not name your owned folder, change nothing/);
    assert.match(body, /Never say the task is done/);
  }
});

test("the adversary prompt and /adversary-gate describe the same three gates and hand-back", () => {
  const roleBody = agent("adversary").body;
  const gateBody = prompt("adversary-gate").body;
  for (const gate of ["interface", "repeated failure", "done"]) {
    assert.match(roleBody, new RegExp(`### Gate \\d: ${gate}`), `adversary.md has the ${gate} gate`);
  }
  for (const arg of ["interface", "repeated-failure", "done"]) assert.ok(gateBody.includes(`| \`${arg}\` |`), arg);
  const handBack = "Gate: <interface | repeated failure | done>\nVerdict: <agree or disagree | fixed or hidden | sign off or not done>";
  assert.ok(roleBody.includes(handBack), "adversary.md hand-back");
  assert.ok(gateBody.includes(handBack), "adversary-gate.md hand-back");
});

// pi substitutes these patterns in a template body (core/prompt-templates.ts).
// A stray one in prose, such as a dollar amount, would be replaced silently.
const PLACEHOLDER = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

test("each team prompt has a description and uses only its intended argument placeholders", () => {
  const expected = {
    team: ["$@"],
    "adversary-gate": ["$1", "${@:2}"],
    retro: ["${@:-this current session}"],
  };
  for (const name of TEAM_PROMPTS) {
    const { frontmatter, body } = prompt(name);
    assert.ok(frontmatter.description?.length > 20, `${name} has a description`);
    assert.ok(frontmatter["argument-hint"], `${name} has an argument hint`);
    assert.deepEqual(body.match(PLACEHOLDER) ?? [], expected[name], name);
  }
});

test("/retro credits its MIT-licensed source and the license text is present", () => {
  const { frontmatter, body } = prompt("retro");
  assert.match(frontmatter.source, /github\.com\/mattpocock\/skills\/blob\/[0-9a-f]{40}\//);
  assert.match(body, /Matt Pocock's `retro` skill, which is under the MIT License/);
  const license = read(path.join(piAgent, "licenses", "mattpocock-skills.txt"));
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Matt Pocock/);
  assert.match(license, /The above copyright notice and this permission notice shall be included/);
});

// .gitignore here is a deny-by-default allowlist. A file it ignores works on
// this machine and is simply absent from every other clone.
test("the .gitignore allowlist tracks every team file", (t) => {
  const repo = path.join(piAgent, "..");
  if (!existsSync(path.join(repo, ".git"))) return t.skip("not a git checkout");
  const files = [
    ...TEAM.map((n) => `.pi-agent/agents/${n}.md`),
    ...TEAM_PROMPTS.map((n) => `.pi-agent/prompts/${n}.md`),
    ".pi-agent/licenses/mattpocock-skills.txt",
  ];
  const result = spawnSync("git", ["check-ignore", "--no-index", ...files], { cwd: repo, encoding: "utf8" });
  assert.equal(result.stdout.trim(), "", `ignored: ${result.stdout}`);
});

test("mise links each agent file into ~/.pi/agent/agents", () => {
  const mise = read(path.join(piAgent, "..", "mise.toml"));
  assert.match(mise, /^"~\/\.pi\/agent\/agents" = \{ source = "\.pi-agent\/agents", mode = "symlink-each" \}$/m);
});
