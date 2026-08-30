import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checker = join(repo, "bin", "pi-profile-check");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function profile({ packages, marker = "npm:@nicknisi/pi-stash", sharedExtensions = false }) {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-check-test-"));
  temporaryDirectories.push(root);
  const profileDir = join(root, "profile");
  const extensionDir = sharedExtensions ? join(root, "shared-extensions") : join(profileDir, "extensions");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  if (sharedExtensions) await symlink(extensionDir, join(profileDir, "extensions"));
  await writeFile(join(profileDir, "settings.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
  await writeFile(join(extensionDir, "stash.ts"), `// @replaces ${marker}\nexport default function stash() {}\n`);
  return profileDir;
}

function check(...profiles) {
  return spawnSync(checker, profiles, { encoding: "utf8" });
}

test("passes when a profile does not load the replaced package", async () => {
  const profileDir = await profile({ packages: ["npm:another-extension"] });
  const result = check(profileDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 profile\(s\) passed/);
});

test("detects an exact package source beside a shared local replacement", async () => {
  const profileDir = await profile({ packages: ["npm:@nicknisi/pi-stash"], sharedExtensions: true });
  const result = check(profileDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /loads both npm:@nicknisi\/pi-stash and its local replacement extensions\/stash\.ts/);
});

test("detects pinned and object-form package sources", async () => {
  const profileDir = await profile({
    packages: [{ source: "npm:@nicknisi/pi-stash@1.2.3", extensions: ["index.ts"] }],
  });
  const result = check(profileDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm:@nicknisi\/pi-stash@1\.2\.3/);
});

test("checks multiple profiles while skipping profiles that do not exist", async () => {
  const clean = await profile({ packages: [] });
  const conflict = await profile({ packages: ["npm:@nicknisi/pi-stash"] });
  const result = check(join(tmpdir(), "missing-pi-profile"), clean, conflict);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(conflict.replaceAll("/", "\\/")));
});

// --- managed links -------------------------------------------------------
// A stand-in dotfiles repo: mise.toml's dotfiles table is the list of managed
// paths, so the checker reads it rather than carrying its own copy.
async function linkFixture({ host = "testbox", models = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "pi-links-home-"));
  const dots = await mkdtemp(join(tmpdir(), "pi-links-repo-"));
  temporaryDirectories.push(home, dots);
  await mkdir(join(dots, ".pi-agent", "extensions"), { recursive: true });
  await writeFile(join(dots, "mise.toml"),
    ['"~/.pi/agent/keybindings.json" = ".pi-agent/keybindings.json"',
     '"~/.pi/agent/extensions" = ".pi-agent/extensions"', ""].join("\n"));
  await writeFile(join(dots, ".pi-agent", "keybindings.json"), "{}\n");
  await writeFile(join(dots, ".pi-agent", `settings.${host}.json`), "{}\n");
  if (models) await writeFile(join(dots, ".pi-agent", `models.${host}.json`), "{}\n");
  const agent = join(home, ".pi", "agent");
  await mkdir(agent, { recursive: true });
  for (const [name, target] of [
    ["keybindings.json", join(dots, ".pi-agent", "keybindings.json")],
    ["extensions", join(dots, ".pi-agent", "extensions")],
    ["settings.json", join(dots, ".pi-agent", `settings.${host}.json`)],
  ]) await symlink(target, join(agent, name));
  return { home, dots, agent, host };
}

function checkLinks({ home, dots, host }, ...profiles) {
  return spawnSync(checker, ["--links-only", ...profiles], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PI_DOTFILES_ROOT: dots, PI_SETTINGS_HOST: host },
  });
}

test("passes a profile whose managed paths are all links to the repo", async () => {
  const fixture = await linkFixture();
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 0, result.stderr);
});

test("detects a real file written over a managed link", async () => {
  const fixture = await linkFixture();
  await rm(join(fixture.agent, "settings.json"));
  await writeFile(join(fixture.agent, "settings.json"), '{"packages":[]}\n');
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settings\.json is a regular file where .*settings\.testbox\.json belongs/);
  assert.match(result.stderr, /renames it to settings\.json\.bak/);
});

test("detects a link left pointing at another host's file", async () => {
  const fixture = await linkFixture();
  await writeFile(join(fixture.dots, ".pi-agent", "settings.otherbox.json"), "{}\n");
  await rm(join(fixture.agent, "settings.json"));
  await symlink(join(fixture.dots, ".pi-agent", "settings.otherbox.json"), join(fixture.agent, "settings.json"));
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /points at .*settings\.otherbox\.json, not .*settings\.testbox\.json/);
});

test("detects a dangling managed link", async () => {
  const fixture = await linkFixture();
  await rm(join(fixture.agent, "keybindings.json"));
  await symlink(join(fixture.dots, "gone.json"), join(fixture.agent, "keybindings.json"));
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /keybindings\.json is a dangling link/);
});

test("accepts a real models.json on a host with no tracked models file", async () => {
  const fixture = await linkFixture();
  await writeFile(join(fixture.agent, "models.json"), "{}\n");
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 0, result.stderr);
});

test("flags that same models.json once the host has a tracked one", async () => {
  const fixture = await linkFixture({ models: true });
  await writeFile(join(fixture.agent, "models.json"), "{}\n");
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /models\.json is a regular file/);
});

test("ignores managed paths that do not exist yet", async () => {
  const fixture = await linkFixture();
  await rm(join(fixture.agent, "extensions"));
  const result = checkLinks(fixture, fixture.agent);
  assert.equal(result.status, 0, result.stderr);
});

test("--packages-only skips the link audit", async () => {
  const fixture = await linkFixture();
  await rm(join(fixture.agent, "settings.json"));
  await writeFile(join(fixture.agent, "settings.json"), '{"packages":[]}\n');
  await mkdir(join(fixture.agent, "extensions", "x"), { recursive: true }).catch(() => {});
  const result = spawnSync(checker, ["--packages-only", fixture.agent], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixture.home, PI_DOTFILES_ROOT: fixture.dots, PI_SETTINGS_HOST: fixture.host },
  });
  assert.equal(result.status, 0, result.stderr);
});
