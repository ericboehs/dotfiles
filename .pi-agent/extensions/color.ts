// /color [name|#rrggbb|0-255|auto|off] — tint this session's input border,
// the way Claude Code's /color does.
//
// The point is telling concurrent sessions apart: four panes running pi look
// identical until one of them is pink. Claude Code recolors the prompt box and
// deliberately does not persist the choice, and this matches that — the color
// lives in the process, not in settings.json.
//
// How it works: pi paints the editor border with the theme's thinking-level
// colors (thinkingOff..thinkingMax), and nothing else reads those tokens. So a
// clone of the live theme with those seven tokens overwritten recolors the
// border and leaves every other surface — transcript, tools, markdown, syntax
// — exactly as the theme author wrote it. `bashMode` is left alone on purpose,
// so `!` still turns the border its own color no matter what /color is set to.
//
// Two consequences of pi's setThemeInstance(), both intentional trades:
//   - the theme file watcher stops, so editing the active custom theme's JSON
//     no longer hot-reloads until /color off;
//   - picking a theme in /settings replaces the instance and drops the tint.
//     The next /color notices (the live theme is no longer ours) and re-tints
//     from whatever is current rather than resurrecting the old base.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/**
 * The editor border tokens. pi picks one of these per thinking level; setting
 * all seven to the same value makes the border a session marker instead of a
 * thinking-level readout (which the footer already prints as text anyway).
 */
const BORDER_TOKENS = [
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
] as const;

/** Claude's /color palette, at saturations that survive both light and dark backgrounds. */
const PALETTE: Record<string, string> = {
  red: "#ff5f5f",
  orange: "#ff8c42",
  yellow: "#d7af00",
  green: "#4fb04f",
  cyan: "#00b3b3",
  blue: "#5f87ff",
  purple: "#a878ff",
  pink: "#ff7ac6",
  gray: "#8a8a8a",
};

const PALETTE_NAMES = Object.keys(PALETTE);

/** Words that mean "put the theme back". */
const OFF_WORDS = new Set(["off", "none", "default", "reset", "clear"]);

/**
 * State lives on globalThis, not in module scope: /reload re-executes this
 * file, and losing the baseline theme there would make /color off restore
 * nothing. Keyed like the footer's boot-version stash.
 */
const STASH_KEY = "__piSessionColor";

interface ColorState {
  /** What the user asked for ("blue", "#ff0088", "204"), or undefined when off. */
  spec?: string;
  /** The theme as it was before we tinted it — what /color off restores. */
  baseline?: Theme;
  /** The tinted instance we handed to pi, used to detect a theme change from elsewhere. */
  tinted?: Theme;
}

function stash(): ColorState {
  const store = globalThis as { [STASH_KEY]?: ColorState };
  const existing = store[STASH_KEY];
  if (existing) return existing;
  const created: ColorState = {};
  store[STASH_KEY] = created;
  return created;
}

// ---------------------------------------------------------------------------
// Color values
// ---------------------------------------------------------------------------

/** A resolved color: a hex string, or an xterm-256 palette index. */
type ColorValue = string | number;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const body = hex.slice(1);
  const full =
    body.length === 3 ?
      `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
    : body;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** The 6x6x6 cube channel steps behind indices 16-231. */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function closestCubeIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_STEPS.length; i++) {
    if (Math.abs(value - CUBE_STEPS[i]!) < Math.abs(value - CUBE_STEPS[best]!)) best = i;
  }
  return best;
}

/**
 * The SGR foreground sequence for a color, in the same shape pi's own theme
 * loader produces — that is what the cloned map holds.
 *
 * The 256-color path only walks the color cube, skipping the grayscale ramp pi
 * considers: every palette entry here is saturated, and a custom hex picked to
 * mark a session is not one somebody wants quietly rounded to gray.
 */
function fgAnsi(value: ColorValue, mode: string): string {
  if (typeof value === "number") return `\x1b[38;5;${value}m`;
  const { r, g, b } = hexToRgb(value);
  if (mode !== "256color") return `\x1b[38;2;${r};${g};${b}m`;
  const index = 16 + 36 * closestCubeIndex(r) + 6 * closestCubeIndex(g) + closestCubeIndex(b);
  return `\x1b[38;5;${index}m`;
}

/**
 * Parse one /color argument. Returns null for "not a color".
 *
 * Bare digits are read as an xterm palette index before hex, so `204` is
 * xterm 204 rather than the shorthand hex it also spells; `#204` still means
 * `#220044`.
 */
function parseColor(input: string): ColorValue | null {
  const token = input.trim().toLowerCase();
  if (!token) return null;
  if (token in PALETTE) return PALETTE[token]!;
  if (/^\d{1,3}$/.test(token)) {
    const index = Number.parseInt(token, 10);
    return index <= 255 ? index : null;
  }
  if (/^#?[0-9a-f]{6}$/.test(token) || /^#?[0-9a-f]{3}$/.test(token)) {
    return token.startsWith("#") ? token : `#${token}`;
  }
  return null;
}

/** A short, stable hash — enough to spread session names across nine colors. */
function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

function swatch(value: ColorValue): string {
  // Rendered raw into menu labels, so it carries its own reset. Truecolor here
  // regardless of the theme's mode: menus are ephemeral, and a terminal
  // without truecolor ignores the sequence rather than mangling the row.
  return `${fgAnsi(value, "truecolor")}██\x1b[39m`;
}

/** "blue (#5f87ff)", "#ff0088", "xterm 204" — what to echo back after applying. */
function describe(token: string, value: ColorValue): string {
  if (token in PALETTE) return `${token} (${value as string})`;
  return typeof value === "number" ? `xterm ${value}` : value;
}

// ---------------------------------------------------------------------------
// Theme tinting
// ---------------------------------------------------------------------------

/** The private shape we borrow: pi keeps token -> SGR string, already encoded. */
interface ThemeInternals {
  fgColors: Map<string, string>;
}

/**
 * Clone a theme with the border tokens repainted.
 *
 * pi has no public "theme with overrides" API — Theme's constructor wants all
 * 51 resolved color values and the live instance only exposes them as encoded
 * SGR strings. Copying the instance and swapping seven entries of its color
 * map is the smallest thing that works, and it inherits everything a future pi
 * adds to a theme for free. Returns null if that map ever stops being a Map,
 * so a pi upgrade degrades to an error message instead of a broken theme.
 */
function tint(base: Theme, value: ColorValue): Theme | null {
  const colors = (base as unknown as Partial<ThemeInternals>).fgColors;
  if (!(colors instanceof Map)) return null;
  const clone = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base) as Theme;
  const next = new Map(colors);
  const ansi = fgAnsi(value, base.getColorMode());
  for (const token of BORDER_TOKENS) next.set(token, ansi);
  (clone as unknown as ThemeInternals).fgColors = next;
  return clone;
}

/**
 * Where pi keeps the live theme instance. `ctx.ui.theme` is a module-level
 * Proxy over this slot (so every module loader sees one theme), and it only
 * traps `get`: property reads forward, but the proxy has no own keys for
 * Object.assign to copy, its prototype is Object.prototype rather than
 * Theme's, and it never compares equal to the instance we installed. Since
 * `setTheme` routes on `instanceof Theme`, cloning the proxy would hand pi
 * something it treats as a theme *name* and silently fall back to dark. So
 * unwrap it. The fallback covers hosts that hand over the instance directly.
 */
const THEME_SLOT = Symbol.for("@earendil-works/pi-coding-agent:theme");

function liveTheme(ctx: ExtensionContext): Theme {
  const instance = (globalThis as Record<symbol, unknown>)[THEME_SLOT];
  return (instance as Theme | undefined) ?? ctx.ui.theme;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function colorExtension(pi: ExtensionAPI): void {
  const state = stash();

  /**
   * The theme to tint from. While our own tint is live that is the remembered
   * baseline; if anything else swapped the theme (/settings, a light/dark
   * flip), the live instance becomes the new baseline.
   */
  function baseline(ctx: ExtensionContext): Theme {
    const live = liveTheme(ctx);
    if (state.tinted && live === state.tinted && state.baseline) return state.baseline;
    state.baseline = live;
    return live;
  }

  function apply(ctx: ExtensionContext, value: ColorValue): string | null {
    const tinted = tint(baseline(ctx), value);
    if (!tinted) return "this pi version stores theme colors differently — /color needs an update";
    const result = ctx.ui.setTheme(tinted);
    if (!result.success) return result.error ?? "failed to apply the theme";
    state.tinted = tinted;
    return null;
  }

  function restore(ctx: ExtensionContext): void {
    const base = state.baseline;
    state.spec = undefined;
    state.tinted = undefined;
    state.baseline = undefined;
    // Nothing to restore if the theme was replaced from elsewhere in the
    // meantime — that replacement is already untinted.
    if (base && base !== liveTheme(ctx)) ctx.ui.setTheme(base);
  }

  /** The seed for /color auto: distinct per session, stable across /reload. */
  function seed(): string {
    return pi.getSessionName() || String(process.pid);
  }

  async function pick(ctx: ExtensionCommandContext): Promise<string | undefined> {
    const labels = new Map<string, string>();
    for (const name of PALETTE_NAMES) labels.set(`${swatch(PALETTE[name]!)} ${name}`, name);
    // Padded to line up with the swatches above it.
    labels.set("   off (restore theme)", "off");
    const chosen = await ctx.ui.select("Session color", [...labels.keys()]);
    return chosen === undefined ? undefined : labels.get(chosen);
  }

  pi.registerCommand("color", {
    description: "Tint this session's input border: /color [name|#hex|0-255|auto|off]",
    getArgumentCompletions: (prefix): AutocompleteItem[] => {
      const typed = prefix.trim().toLowerCase();
      const items: AutocompleteItem[] = PALETTE_NAMES.map((name) => ({
        value: name,
        label: name,
        description: `${swatch(PALETTE[name]!)} ${PALETTE[name]!}`,
      }));
      items.push({ value: "auto", label: "auto", description: "derive one from the session name" });
      items.push({ value: "off", label: "off", description: "restore the theme's border" });
      return items.filter((item) => item.value.startsWith(typed));
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      let token = args.trim().toLowerCase();
      if (!token) {
        const picked = await pick(ctx);
        if (picked === undefined) return; // dismissed
        token = picked;
      }

      if (OFF_WORDS.has(token)) {
        if (!state.spec) {
          ctx.ui.notify("No session color set", "info");
          return;
        }
        restore(ctx);
        ctx.ui.notify("Session color cleared", "info");
        return;
      }

      if (token === "list") {
        ctx.ui.notify(
          PALETTE_NAMES.map((name) => `${swatch(PALETTE[name]!)} ${name}`).join("  "),
          "info",
        );
        return;
      }

      if (token === "auto") token = PALETTE_NAMES[hash(seed()) % PALETTE_NAMES.length]!;

      const value = parseColor(token);
      if (value === null) {
        ctx.ui.notify(
          `Unknown color "${token}". Try: ${PALETTE_NAMES.join(", ")}, #rrggbb, 0-255, auto, off`,
          "warning",
        );
        return;
      }

      const error = apply(ctx, value);
      if (error) {
        ctx.ui.notify(error, "error");
        return;
      }
      state.spec = token;
      ctx.ui.notify(`Session color: ${swatch(value)} ${describe(token, value)}`, "info");
    },
  });

  // A /reload re-executes this module but leaves the tinted instance installed,
  // so this is mostly a repair hook: it puts the color back if the theme was
  // reinitialized underneath us (new session, resume, light/dark flip).
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || !state.spec) return;
    if (state.tinted && liveTheme(ctx) === state.tinted) return;
    const value = parseColor(state.spec);
    if (value !== null) apply(ctx, value);
  });
}
