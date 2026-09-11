import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webChat from "../extensions/web-chat.ts";

async function fixture(source, run) {
  const home = await mkdtemp(join(tmpdir(), "pi-web-chat-test-"));
  try {
    if (source !== undefined) {
      const bridge = join(home, "Code/github.com/ericboehs/psst-web/bridge");
      await mkdir(bridge, { recursive: true });
      await writeFile(join(bridge, "extension.mjs"), source);
    }
    await run(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}

function fakePi() {
  const commands = new Map(), events = new Map(), notices = [];
  return { commands, events, notices,
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    sendUserMessage: () => assert.fail("Loading must never submit a message"),
  };
}

test("loading delegates registration to the optional local bridge without starting resources", async () => {
  await fixture(`export default async function(pi) {
    pi.on('session_shutdown', () => {});
    pi.registerCommand('web-chat', { description: 'Fixture bridge', handler: async () => {} });
  }`, async (home) => {
    const pi = fakePi();
    await webChat(pi, home);
    assert.equal(pi.commands.size, 1);
    assert.equal(pi.commands.get("web-chat").description, "Fixture bridge");
    assert(pi.events.has("session_shutdown"));
    assert.deepEqual(pi.notices, []);
  });
});

test("missing or broken optional checkouts leave pi usable and explain only on command", async () => {
  for (const source of [undefined, "export default 42;", 'throw new Error("PRIVATE_FIXTURE_DIAGNOSTIC");']) {
    await fixture(source, async (home) => {
      const pi = fakePi();
      await webChat(pi, home);
      assert.equal(pi.commands.size, 1);
      assert.equal(pi.events.size, 0);
      assert.deepEqual(pi.notices, []);
      await pi.commands.get("web-chat").handler("on", { ui: { notify: (...args) => pi.notices.push(args) } });
      assert.match(pi.notices[0][0], /Nothing was connected/);
      assert.equal(pi.notices[0][1], "warning");
      assert(!JSON.stringify(pi.notices).includes("PRIVATE_FIXTURE_DIAGNOSTIC"));
      assert(!JSON.stringify(pi.notices).includes(home));
    });
  }
});
