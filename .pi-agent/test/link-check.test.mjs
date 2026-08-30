import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checker = join(repo, "bin", "dotfiles-link-check");
const profileChecker = join(repo, "bin", "pi-profile-check");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// A stand-in dotfiles repo. The checker reads mise.toml's [dotfiles] table
// rather than carrying its own list, so the fixture writes one.
async function fixture({ host = "testbox", models = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "link-check-home-"));
  const dots = await mkdtemp(join(tmpdir(), "link-check-repo-"));
  temporaryDirectories.push(home, dots);

  await mkdir(join(dots, ".pi-agent", "extensions"), { recursive: true });
  await mkdir(join(dots, ".config", "lsd"), { recursive: true });
  await writeFile(join(dots, "mise.toml"), [
    "[dotfiles]",
    '"~/.zshrc" = ".zshrc"',
    '"~/.gitignore" = ".gitignore.global"',
    '"~/.config/lsd" = { source = ".config/lsd", mode = "symlink-each" }',
    '"~/.pi/agent/keybindings.json" = ".pi-agent/keybindings.json"',
    '"~/.pi/agent/extensions" = ".pi-agent/extensions"',
    "",
    "[tasks.bootstrap]",
    'run = "true"',
    "",
  ].join("\n"));

  for (const [path, body] of [
    [".zshrc", "# zshrc\n"],
    [".gitignore.global", "*.swp\n"],
    [join(".config", "lsd", "config.yaml"), "{}\n"],
    [join(".pi-agent", "keybindings.json"), "{}\n"],
    [join(".pi-agent", `settings.${host}.json`), "{}\n"],
  ]) await writeFile(join(dots, path), body);
  if (models) await writeFile(join(dots, ".pi-agent", `models.${host}.json`), "{}\n");

  const agent = join(home, ".pi", "agent");
  await mkdir(agent, { recursive: true });
  await mkdir(join(home, ".config", "lsd"), { recursive: true });
  for (const [target, source] of [
    [".zshrc", ".zshrc"],
    [".gitignore", ".gitignore.global"],
    [join(".config", "lsd", "config.yaml"), join(".config", "lsd", "config.yaml")],
    [join(".pi", "agent", "keybindings.json"), join(".pi-agent", "keybindings.json")],
    [join(".pi", "agent", "extensions"), join(".pi-agent", "extensions")],
    [join(".pi", "agent", "settings.json"), join(".pi-agent", `settings.${host}.json`)],
  ]) await symlink(join(dots, source), join(home, target));

  return { home, dots, agent, host };
}

function check({ home, dots, host }, args = []) {
  return spawnSync(checker, args, {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PI_DOTFILES_ROOT: dots, PI_SETTINGS_HOST: host },
  });
}

test("passes when every managed path is still its link", async () => {
  const f = await fixture();
  const result = check(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 managed path\(s\) intact/);
});

test("detects a real file written over a managed link", async () => {
  const f = await fixture();
  await rm(join(f.agent, "settings.json"));
  await writeFile(join(f.agent, "settings.json"), '{"packages":[]}\n');
  const result = check(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settings\.json is a regular file where .*settings\.testbox\.json belongs/);
  assert.match(result.stderr, /renames it to settings\.json\.bak/);
});

test("audits a renamed link by its target name, not its source name", async () => {
  const f = await fixture();
  await rm(join(f.home, ".gitignore"));
  await writeFile(join(f.home, ".gitignore"), "*.log\n");
  const result = check(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.gitignore is a regular file where .*\.gitignore\.global belongs/);
});

test("audits the contents of a symlink-each directory, not the directory", async () => {
  const f = await fixture();
  await rm(join(f.home, ".config", "lsd", "config.yaml"));
  await writeFile(join(f.home, ".config", "lsd", "config.yaml"), "{}\n");
  const result = check(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lsd\/config\.yaml is a regular file/);
});

test("detects a link left pointing at another host's file", async () => {
  const f = await fixture();
  await writeFile(join(f.dots, ".pi-agent", "settings.otherbox.json"), "{}\n");
  await rm(join(f.agent, "settings.json"));
  await symlink(join(f.dots, ".pi-agent", "settings.otherbox.json"), join(f.agent, "settings.json"));
  const result = check(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /points at .*settings\.otherbox\.json, not .*settings\.testbox\.json/);
});

test("detects a dangling managed link", async () => {
  const f = await fixture();
  await rm(join(f.agent, "keybindings.json"));
  await symlink(join(f.dots, "gone.json"), join(f.agent, "keybindings.json"));
  const result = check(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /keybindings\.json is a dangling link/);
});

test("accepts a real models.json on a host with no tracked models file", async () => {
  const f = await fixture();
  await writeFile(join(f.agent, "models.json"), "{}\n");
  assert.equal(check(f).status, 0);
});

test("flags that same models.json once the host has a tracked one", async () => {
  const f = await fixture({ models: true });
  await writeFile(join(f.agent, "models.json"), "{}\n");
  const result = check(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /models\.json is a regular file/);
});

test("ignores managed paths that do not exist here yet", async () => {
  const f = await fixture();
  await rm(join(f.agent, "extensions"));
  assert.equal(check(f).status, 0);
});

test("a path prefix scopes the audit", async () => {
  const f = await fixture();
  await rm(join(f.home, ".zshrc"));
  await writeFile(join(f.home, ".zshrc"), "# local\n");
  assert.equal(check(f, [join(f.home, ".pi")]).status, 0);
  assert.equal(check(f).status, 1);
});

test("pi-profile-check delegates its link audit here, scoped to the profile", async () => {
  const f = await fixture();
  await rm(join(f.agent, "settings.json"));
  await writeFile(join(f.agent, "settings.json"), '{"packages":[]}\n');
  const env = { ...process.env, HOME: f.home, PI_DOTFILES_ROOT: f.dots, PI_SETTINGS_HOST: f.host };
  const result = spawnSync(profileChecker, [f.agent], { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dotfiles-link-check: .*settings\.json is a regular file/);

  const skipped = spawnSync(profileChecker, ["--packages-only", f.agent], { encoding: "utf8", env });
  assert.equal(skipped.status, 0, skipped.stderr);
});
