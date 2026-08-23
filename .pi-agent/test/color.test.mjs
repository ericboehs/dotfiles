/**
 * Smoke tests for the /color extension.
 *
 * Runs the real extension against a stub theme shaped like pi's — a class
 * instance whose fgColors is a Map of token to SGR string — so the clone path
 * (prototype, own fields, swapped map) is exercised the way pi will exercise
 * it. Also proves the file loads under Node's type stripping, which is how pi
 * loads it.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import color from "../extensions/color.ts";

const BORDER_TOKENS = [
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
];

/** Same surface the extension touches on a real pi Theme. */
class StubTheme {
  constructor(mode = "truecolor", name = "dark") {
    this.name = name;
    this.mode = mode;
    this.fgColors = new Map([
      ["accent", "\x1b[38;2;0;170;255m"],
      ["bashMode", "\x1b[38;2;255;170;0m"],
      ...BORDER_TOKENS.map((token) => [token, "\x1b[38;2;100;100;100m"]),
    ]);
    this.bgColors = new Map([["selectedBg", "\x1b[48;2;45;45;48m"]]);
  }

  getColorMode() {
    return this.mode;
  }
}

/** pi's global theme slot: `ctx.ui.theme` is only a proxy over this. */
const THEME_SLOT = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** Same read-only forwarding proxy pi exports as `theme`. */
const THEME_PROXY = new Proxy(
  {},
  {
    get(_target, prop) {
      return globalThis[THEME_SLOT][prop];
    },
  },
);

function mount(overrides = {}) {
  // Every mount starts from a clean stash: the extension keeps state on
  // globalThis so it survives /reload, which would otherwise leak between tests.
  delete globalThis.__piSessionColor;

  const notices = [];
  const setThemes = [];
  let selection = overrides.selection;
  globalThis[THEME_SLOT] = overrides.theme ?? new StubTheme(overrides.mode);

  const ctx = {
    hasUI: overrides.hasUI ?? true,
    get ui() {
      return {
        // `rawTheme` stands in for a host that hands over the instance itself.
        get theme() {
          return overrides.rawTheme ? globalThis[THEME_SLOT] : THEME_PROXY;
        },
        setTheme: (next) => {
          setThemes.push(next);
          if (overrides.setThemeFails) return { success: false, error: "nope" };
          globalThis[THEME_SLOT] = next;
          return { success: true };
        },
        select: async (_title, options) => {
          if (typeof selection === "number") return options[selection];
          return selection;
        },
        notify: (message, level) => notices.push({ message, level }),
      };
    },
  };

  const pi = {
    getSessionName: () => overrides.sessionName,
    registerCommand: (name, options) => {
      pi.commands[name] = options;
    },
    on: (name, handler) => {
      pi.handlers[name] = handler;
    },
    commands: {},
    handlers: {},
  };

  color(pi);

  return {
    ctx,
    notices,
    setThemes,
    complete: (prefix) => pi.commands.color.getArgumentCompletions(prefix),
    run: (args = "") => pi.commands.color.handler(args, ctx),
    startSession: (event = {}) => pi.handlers.session_start(event, ctx),
    theme: () => globalThis[THEME_SLOT],
    setTheme: (next) => {
      globalThis[THEME_SLOT] = next;
    },
    /** The SGR string all seven border tokens now share, or null if they differ. */
    border: () => {
      const colors = globalThis[THEME_SLOT].fgColors;
      const values = new Set(BORDER_TOKENS.map((token) => colors.get(token)));
      return values.size === 1 ? [...values][0] : null;
    },
  };
}

function strip(text) {
  return text.replace(new RegExp(String.raw`\x1B\[[0-9;]*m`, "g"), "");
}

test("a named color repaints every border token", async () => {
  const ui = mount();
  await ui.run("blue");
  assert.equal(ui.border(), "\x1b[38;2;95;135;255m");
  assert.match(strip(ui.notices.at(-1).message), /Session color: .*blue \(#5f87ff\)/);
});

test("the tinted theme is a real Theme instance, not a copy of pi's proxy", async () => {
  const ui = mount();
  const base = ui.theme();
  await ui.run("blue");
  const applied = ui.setThemes.at(-1);
  assert.ok(applied instanceof StubTheme, "setTheme routes on instanceof");
  assert.equal(Object.getPrototypeOf(applied), Object.getPrototypeOf(base));
  assert.equal(applied.name, base.name, "own fields came across");
});

test("hosts that pass the theme instance instead of a proxy work too", async () => {
  const ui = mount({ rawTheme: true });
  const base = ui.theme();
  await ui.run("blue");
  assert.equal(ui.border(), "\x1b[38;2;95;135;255m");
  await ui.run("off");
  assert.equal(ui.theme(), base);
});

test("the tint leaves the rest of the theme alone", async () => {
  const ui = mount();
  const before = ui.theme();
  await ui.run("pink");
  const after = ui.theme();
  assert.notEqual(after, before, "should install a clone, not mutate in place");
  assert.equal(before.fgColors.get("thinkingHigh"), "\x1b[38;2;100;100;100m", "base untouched");
  assert.equal(after.fgColors.get("accent"), before.fgColors.get("accent"));
  assert.equal(after.fgColors.get("bashMode"), before.fgColors.get("bashMode"), "bash mode keeps its own color");
  assert.equal(after.bgColors, before.bgColors);
  assert.equal(after.name, "dark");
  assert.equal(after.getColorMode(), "truecolor", "prototype methods survive the clone");
});

test("hex and xterm indices work, in long and short form", async () => {
  for (const [input, expected] of [
    ["#ff0088", "\x1b[38;2;255;0;136m"],
    ["ff0088", "\x1b[38;2;255;0;136m"],
    ["#f08", "\x1b[38;2;255;0;136m"],
    ["#204", "\x1b[38;2;34;0;68m"],
    ["204", "\x1b[38;5;204m"],
    ["0", "\x1b[38;5;0m"],
  ]) {
    const ui = mount();
    await ui.run(input);
    assert.equal(ui.border(), expected, input);
  }
});

test("256-color terminals get the nearest cube entry", async () => {
  const ui = mount({ mode: "256color" });
  await ui.run("blue"); // #5f87ff -> 16 + 36*1 + 6*2 + 5
  assert.equal(ui.border(), "\x1b[38;5;69m");
});

test("garbage is refused with the list of what works", async () => {
  const ui = mount();
  await ui.run("chartreuse");
  assert.equal(ui.setThemes.length, 0);
  assert.equal(ui.notices.at(-1).level, "warning");
  assert.match(ui.notices.at(-1).message, /Unknown color "chartreuse"/);
  await ui.run("256");
  assert.equal(ui.setThemes.length, 0, "out of the xterm range");
});

test("off restores the exact theme instance that was live before", async () => {
  const ui = mount();
  const base = ui.theme();
  await ui.run("green");
  assert.notEqual(ui.theme(), base);
  await ui.run("off");
  assert.equal(ui.theme(), base);
  assert.match(ui.notices.at(-1).message, /cleared/);
});

test("off without a color set changes nothing", async () => {
  const ui = mount();
  await ui.run("off");
  assert.equal(ui.setThemes.length, 0);
  assert.equal(ui.notices.at(-1).message, "No session color set");
});

test("recoloring tints the original theme, never the previous tint", async () => {
  const ui = mount();
  const base = ui.theme();
  await ui.run("red");
  await ui.run("blue");
  await ui.run("off");
  assert.equal(ui.theme(), base);
});

test("a theme swapped from elsewhere becomes the new baseline", async () => {
  const ui = mount();
  await ui.run("red");
  const swapped = new StubTheme("truecolor", "light");
  ui.setTheme(swapped); // as /settings would
  await ui.run("blue");
  assert.equal(ui.theme().name, "light");
  await ui.run("off");
  assert.equal(ui.theme(), swapped, "should not resurrect the pre-swap theme");
});

test("auto derives a palette color from the session name, deterministically", async () => {
  // Each mount takes over the shared theme slot, so read the border before the
  // next one starts.
  const run = async (sessionName) => {
    const ui = mount({ sessionName });
    await ui.run("auto");
    return ui.border();
  };
  const first = await run("eert");
  assert.equal(first, await run("eert"));
  assert.notEqual(await run("dotfiles"), first, "different names should usually differ");
});

test("no argument opens the picker and applies the choice", async () => {
  const ui = mount({ selection: 0 }); // first palette entry: red
  await ui.run("");
  assert.equal(ui.border(), "\x1b[38;2;255;95;95m");
});

test("dismissing the picker leaves the theme alone", async () => {
  const ui = mount({ selection: undefined });
  await ui.run("");
  assert.equal(ui.setThemes.length, 0);
  assert.equal(ui.notices.length, 0);
});

test("the picker's last entry turns the color off", async () => {
  const ui = mount({ selection: 9 });
  await ui.run("blue");
  await ui.run("");
  assert.match(ui.notices.at(-1).message, /cleared/);
});

test("a theme that stores colors some other way reports instead of breaking", async () => {
  const theme = new StubTheme();
  theme.fgColors = { thinkingHigh: "\x1b[39m" }; // a future pi, or a stub
  const ui = mount({ theme });
  await ui.run("blue");
  assert.equal(ui.setThemes.length, 0);
  assert.equal(ui.notices.at(-1).level, "error");
  assert.match(ui.notices.at(-1).message, /needs an update/);
});

test("a rejected setTheme is reported and not remembered", async () => {
  const ui = mount({ setThemeFails: true });
  await ui.run("blue");
  assert.equal(ui.notices.at(-1).level, "error");
  await ui.run("off");
  assert.equal(ui.notices.at(-1).message, "No session color set");
});

test("completions cover the palette plus auto/off, filtered by prefix", () => {
  const ui = mount();
  const all = ui.complete("");
  assert.deepEqual(
    all.map((item) => item.value),
    ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray", "auto", "off"],
  );
  assert.match(strip(all[0].description), /#ff5f5f/);
  assert.deepEqual(
    ui.complete("p").map((item) => item.value),
    ["purple", "pink"],
  );
});

test("session_start reapplies the color when the theme was reinitialized", async () => {
  const ui = mount();
  await ui.run("blue");
  const fresh = new StubTheme();
  ui.setTheme(fresh); // as a reload/resume that rebuilt the theme would
  await ui.startSession({ reason: "reload" });
  assert.equal(ui.border(), "\x1b[38;2;95;135;255m");
});

test("session_start is a no-op when the tint is still installed", async () => {
  const ui = mount();
  await ui.run("blue");
  const applied = ui.setThemes.length;
  await ui.startSession({ reason: "reload" });
  assert.equal(ui.setThemes.length, applied);
});

test("session_start does nothing without a color set", async () => {
  const ui = mount();
  await ui.startSession({ reason: "startup" });
  assert.equal(ui.setThemes.length, 0);
});

test("headless runs (print/pipe mode) skip the UI entirely", async () => {
  const ui = mount({ hasUI: false });
  await ui.run("blue");
  assert.equal(ui.setThemes.length, 0);
  assert.equal(ui.notices.length, 0);
});
