/**
 * Smoke tests for the native cursor editor.
 *
 * These exist because the extension stopped being a subclass: it now wraps
 * whichever editor is already installed, so that prompt-history.ts and this one
 * can both own the editor no matter which order pi discovers them in.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

const FAKE_CURSOR_LINE = "type here\x1b[7m \x1b[0m";

async function mount() {
  const url = new URL("../extensions/cursor-focus.ts", import.meta.url);
  url.search = `?t=${Math.random()}`;
  const extension = (await import(url.href)).default;

  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler) });

  let installed;
  const hardwareCursor = [];
  const tui = { setShowHardwareCursor: (on) => hardwareCursor.push(on) };
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => installed,
      setEditorComponent: (factory) => {
        installed = factory;
      },
    },
  };

  return {
    hardwareCursor,
    presetEditor: (factory) => {
      installed = factory;
    },
    start: () => handlers.get("session_start")({}, ctx),
    openEditor: () => installed(tui, {}, {}),
  };
}

test("the fake reverse-video cursor is replaced by the terminal's own", async () => {
  const pi = await mount();
  pi.presetEditor(() => ({ render: () => [FAKE_CURSOR_LINE] }));
  pi.start();

  const editor = pi.openEditor();

  assert.deepEqual(editor.render(80), ["type here "], "reverse video stripped, glyph kept");
  assert.deepEqual(pi.hardwareCursor, [true, true], "asserted on install and on every render");
});

test("an editor installed by another extension is kept, not replaced", async () => {
  const pi = await mount();
  let built = 0;
  pi.presetEditor(() => {
    built++;
    return { render: () => [FAKE_CURSOR_LINE], marker: "from the other extension" };
  });
  pi.start();

  const editor = pi.openEditor();

  assert.equal(built, 1);
  assert.equal(editor.marker, "from the other extension", "the wrapped instance is handed back");
});
