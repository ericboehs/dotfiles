import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piPin = join(repo, "bin", "pi-pin");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Keep the fixture repos away from the global gitconfig: its hooks (gitleaks,
// pi-pin --hook itself) and commit signing have no business running here.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd, file, body) {
  return writeFile(join(cwd, file), body).then(() => {
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", `change ${file}`);
    return git(cwd, "rev-parse", "HEAD");
  });
}

// A home with one managed clone of github.com/acme/widget, cloned from a local
// bare "origin", and a dotfiles .pi-agent with two profiles. The live settings
// link to the testbox profile, the way bootstrap:pi links settings.<host>.json.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-pin-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const agentDir = join(root, "dots", ".pi-agent");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const clone = join(home, ".pi", "agent", "git", "github.com", "acme", "widget");
  await mkdir(agentDir, { recursive: true });
  await mkdir(dirname(clone), { recursive: true });

  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  const c1 = await commit(work, "a.txt", "one\n");
  const c2 = await commit(work, "b.txt", "two\n");
  git(work, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, clone);

  const pinAt = async (sha, otherSha = sha) => {
    for (const [profile, pin] of [["testbox", sha], ["other", otherSha]]) {
      await writeFile(join(agentDir, `settings.${profile}.json`), JSON.stringify({
        packages: [`git:github.com/acme/widget@${pin}`],
      }, null, 2) + "\n");
    }
  };
  await symlink(join(agentDir, "settings.testbox.json"), join(home, ".pi", "agent", "settings.json"));

  const run = (args = [], cwd = root) => spawnSync("bash", [piPin, ...args], {
    cwd,
    env: { ...gitEnv, HOME: home, PI_PIN_SETTINGS_DIR: agentDir },
    encoding: "utf8",
  });

  return { root, home, clone, work, c1, c2, pinAt, run };
}

test("a clone at its pin lists ok and passes --check", async () => {
  const f = await fixture();
  git(f.clone, "reset", "-q", "--hard", f.c2);
  await f.pinAt(f.c2);

  const list = f.run();
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /acme\/widget\s+\S+\s+\S+\s+tip\s+ok/);
  assert.equal(f.run(["--check"]).status, 0);
});

test("an unpushed commit in the clone is AHEAD and UNPUSHED, and --check refuses", async () => {
  const f = await fixture();
  await f.pinAt(f.c2);
  const local = await commit(f.clone, "c.txt", "three\n");

  const list = f.run();
  assert.equal(list.status, 1);
  assert.match(list.stdout, /AHEAD \+1, 1 UNPUSHED - push, then: pi-pin widget/);
  assert.doesNotMatch(list.stdout, /run: pi update/, "must never advise the reconcile that drops the commit");

  const check = f.run(["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /1 commit ahead of its pin .*1 unpushed/);
  assert.match(check.stderr, /would reset it to/);
  assert.match(check.stderr, new RegExp(`then: pi-pin widget ${local}`));
});

test("a pushed but unpinned commit is AHEAD, with the pin-pi command to keep it", async () => {
  const f = await fixture();
  await f.pinAt(f.c1);
  git(f.clone, "reset", "-q", "--hard", f.c2);

  const list = f.run();
  assert.equal(list.status, 1);
  assert.match(list.stdout, /AHEAD \+1 - pi update would drop it; keep it: pi-pin widget/);
  assert.doesNotMatch(list.stdout, /UNPUSHED/);

  const check = f.run(["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, new RegExp(`keep it: pi-pin widget ${f.c2}`));
});

test("a stale clone is BEHIND, which --check leaves to the reconcile", async () => {
  const f = await fixture();
  await f.pinAt(f.c2);
  git(f.clone, "reset", "-q", "--hard", f.c1);

  const list = f.run();
  assert.equal(list.status, 1);
  assert.match(list.stdout, /BEHIND -1 - run: pi update git:github.com\/acme\/widget/);
  assert.equal(f.run(["--check"]).status, 0);
});

test("origin moving past the pin is reported, not a failure", async () => {
  const f = await fixture();
  git(f.clone, "reset", "-q", "--hard", f.c1);
  await f.pinAt(f.c1);

  const list = f.run();
  assert.equal(list.status, 0, list.stdout);
  assert.match(list.stdout, /acme\/widget\s+\S+\s+\S+\s+\+1\s+ok/);
});

test("--fetch counts upstream commits the clone has not seen yet", async () => {
  const f = await fixture();
  git(f.clone, "reset", "-q", "--hard", f.c2);
  await f.pinAt(f.c2);
  await commit(f.work, "d.txt", "four\n");
  git(f.work, "push", "-q", "origin", "main");

  assert.match(f.run().stdout, /\s+tip\s+ok/);
  assert.match(f.run(["--fetch"]).stdout, /\s+\+1\s+ok/);
});

test("profiles that disagree on the pin are named", async () => {
  const f = await fixture();
  git(f.clone, "reset", "-q", "--hard", f.c2);
  await f.pinAt(f.c2, f.c1);

  const list = f.run();
  assert.equal(list.status, 0);
  assert.match(list.stdout, new RegExp(`acme/widget: other profiles pin other=${f.c1.slice(0, 7)}`));
});

test("a reset that orphaned an unpushed commit points at the reflog", async () => {
  const f = await fixture();
  await f.pinAt(f.c2);
  await commit(f.clone, "e.txt", "five\n");
  git(f.clone, "reset", "-q", "--hard", f.c2);

  const list = f.run();
  assert.match(list.stdout, /ok; 1 commit only in the reflog/);
});

test("--hook warns inside a managed clone that moved ahead, and stays quiet elsewhere", async () => {
  const f = await fixture();
  await f.pinAt(f.c2);

  const atPin = f.run(["--hook"], f.clone);
  assert.equal(atPin.status, 0);
  assert.equal(atPin.stderr, "");

  await commit(f.clone, "f.txt", "six\n");
  const ahead = f.run(["--hook"], f.clone);
  assert.equal(ahead.status, 0, "a post-commit hook must never fail");
  assert.match(ahead.stderr, /pi-managed clone/);
  assert.match(ahead.stderr, /would reset it to/);

  const elsewhere = f.run(["--hook"], f.work);
  assert.equal(elsewhere.status, 0);
  assert.equal(elsewhere.stderr, "");
});

test("a bump refuses to strand unpushed commits in the managed clone", async () => {
  const f = await fixture();
  await f.pinAt(f.c1);
  git(f.clone, "reset", "-q", "--hard", f.c2);
  await commit(f.clone, "g.txt", "seven\n");

  const bump = f.run(["widget", f.c2]);
  assert.equal(bump.status, 1);
  assert.match(bump.stderr, /1 unpushed commit the new pin does not contain/);
});
