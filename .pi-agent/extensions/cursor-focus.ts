// Hide / hollow the prompt cursor when the terminal pane loses focus, so it is
// obvious which split pi you are about to type into.
//
// Mechanism: pi draws a *fake* block cursor (reverse-video \x1b[7m..\x1b[0m in
// the editor). pi does not enable terminal focus reporting, so it never knows a
// pane was defocused. This extension turns on DEC mode 1004, watches stdin for
// the FocusIn (\x1b[I) / FocusOut (\x1b[O) escapes that tmux forwards on pane
// switch, and rewrites the cursor sequence while unfocused.
//
// Requires (usually already set): tmux `set -g focus-events on`.

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

// "hide"   -> cursor disappears entirely when the pane is unfocused
// "hollow" -> underline the char under the cursor, box glyph at end of line
const MODE: "hide" | "hollow" = "hide";
const HOLLOW_EMPTY = "\u25af"; // ▯  (used in hollow mode at end of line)

let terminalFocused = true;
let wired = false;
let ownerTui: TUI | undefined;

const CURSOR_ANY = /\x1b\[7m([\s\S]*?)\x1b\[0m/g;
const CURSOR_EMPTY = /\x1b\[7m \x1b\[0m/g;

function rewriteCursor(line: string): string {
  if (terminalFocused) return line;
  if (MODE === "hide") {
    return line.replace(CURSOR_ANY, "$1");
  }
  // hollow
  return line
    .replace(CURSOR_EMPTY, `\x1b[0m${HOLLOW_EMPTY}\x1b[0m`)
    .replace(CURSOR_ANY, "\x1b[4m$1\x1b[24m");
}

class FocusAwareEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    if (!wired) {
      wired = true;
      ownerTui = tui;
      // Ask the terminal (and tmux) to report focus changes.
      process.stdout.write("\x1b[?1004h");
      // Intercept and swallow the focus escapes before they reach key handling.
      tui.addInputListener((data: string) => {
        if (data.indexOf("\x1b[I") === -1 && data.indexOf("\x1b[O") === -1) {
          return;
        }
        // Last focus token in the chunk wins.
        const lastIn = data.lastIndexOf("\x1b[I");
        const lastOut = data.lastIndexOf("\x1b[O");
        terminalFocused = lastIn > lastOut;
        const cleaned = data.split("\x1b[I").join("").split("\x1b[O").join("");
        tui.requestRender();
        return cleaned.length === 0 ? { consume: true } : { data: cleaned };
      });
    }
  }

  render(width: number): string[] {
    return super.render(width).map(rewriteCursor);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new FocusAwareEditor(tui, theme, keybindings),
    );
  });

  pi.on("session_shutdown", () => {
    if (wired) {
      process.stdout.write("\x1b[?1004l");
      ownerTui = undefined;
    }
  });
}
