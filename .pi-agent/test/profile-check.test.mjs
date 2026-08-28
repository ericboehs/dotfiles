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
