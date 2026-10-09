// Omarchy palettes → canvas CSS variables. Shared by the page (as
// /assets/theme.mjs) and the tests, so nothing here touches the DOM.
// The mixes follow Omarchy's own pi.json template (panel = bg + 6% fg,
// border = bg + 20–30% fg, dim text = fg + 52% bg), and the 16 terminal
// colours follow its alacritty template exactly.

const HEX = /^#?([0-9a-f]{6})$/i;

function rgb(hex) {
  const m = String(hex || "").match(HEX);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** a with t (0–1) of b mixed in, as #rrggbb. Bad input falls back to a. */
export function mix(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x) return String(a || "");
  if (!y) return `#${x.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** "tokyo-night" → "Tokyo Night", "retro-82" → "Retro 82". */
export function prettyName(name) {
  return String(name)
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** "dark" or "light"; a theme without a mode is judged by its background. */
export function themeMode(c) {
  if (c?.mode === "dark" || c?.mode === "light") return c.mode;
  const [r, g, b] = rgb(c?.background) || [255, 255, 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
}

/** The page's variables (and the kit's, which are a subset) for one palette. */
export function themeVars(c) {
  const bg = c.background;
  const fg = c.foreground;
  const pick = (...keys) => keys.map((k) => c[k]).find((v) => rgb(v)) || fg;
  const red = pick("red");
  const green = pick("green");
  const yellow = pick("yellow");
  const blue = pick("blue");
  const magenta = pick("magenta");
  const cyan = pick("cyan");
  const orange = pick("orange", "bright_yellow", "yellow");
  const accent = pick("accent", "blue");
  const muted = rgb(c.muted) ? c.muted : mix(bg, fg, 0.35);
  const dim = mix(fg, bg, 0.45);
  return {
    "--bg": rgb(c.dark_background) ? c.dark_background : mix(bg, fg, 0.04),
    "--card": bg,
    "--ink": fg,
    "--dim": dim,
    "--line": mix(bg, fg, 0.18),
    "--soft": mix(bg, fg, 0.07),
    "--code": rgb(c.dark_background) ? mix(bg, c.dark_background, 0.7) : mix(bg, fg, 0.04),
    "--tint": mix(bg, accent, 0.12),
    "--accent": accent,
    "--ok": green,
    "--warn": yellow,
    "--bad": red,
    "--hl-kw": magenta,
    "--hl-str": green,
    "--hl-num": orange,
    "--hl-com": dim,
    "--hl-title": blue,
    "--c1": blue,
    "--c2": orange,
    "--c3": green,
    "--c4": red,
    "--c5": magenta,
    "--c6": yellow,
    "--c7": cyan,
    "--c8": mix(fg, bg, 0.5),
    // Omarchy's alacritty.toml: black = background, bright black = muted.
    "--t0": bg,
    "--t1": red,
    "--t2": green,
    "--t3": yellow,
    "--t4": blue,
    "--t5": magenta,
    "--t6": cyan,
    "--t7": fg,
    "--t8": muted,
    "--t9": pick("bright_red", "red"),
    "--t10": pick("bright_green", "green"),
    "--t11": pick("bright_yellow", "yellow"),
    "--t12": pick("bright_blue", "blue"),
    "--t13": pick("bright_magenta", "magenta"),
    "--t14": pick("bright_cyan", "cyan"),
    "--t15": pick("bright_foreground", "foreground"),
  };
}

/** Five dots for the picker: background, foreground, accent, green, red. */
export function swatch(c) {
  return [c.background, c.foreground, c.accent || c.blue, c.green, c.red].filter((v) => rgb(v));
}

export const DEFAULT_PAIR = { dark: "canvas", light: "canvas" };

/** The stored pair, cleaned: unknown names fall back to the canvas default. */
export function readPair(raw, themes) {
  let p = {};
  try {
    p = typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch {}
  const ok = (n, mode) => n === "canvas" || (themes ? themes[n] && themeMode(themes[n]) === mode : typeof n === "string");
  return { dark: ok(p.dark, "dark") ? p.dark : "canvas", light: ok(p.light, "light") ? p.light : "canvas" };
}
