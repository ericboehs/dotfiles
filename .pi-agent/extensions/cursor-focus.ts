// Hide pi's prompt cursor when its terminal pane loses focus, so it is obvious
// which split pane will receive input.
//
// pi draws a fake cursor by wrapping the character under it in reverse video.
// Because that block remains painted in every tmux pane, inactive pi sessions
// look focused. This extension enables terminal focus reporting, listens for
// FocusIn/FocusOut, and removes the fake block while unfocused.
//
// Requires: tmux `set -g focus-events on`.

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const FAKE_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[0m/g;

interface FocusState {
  focused: boolean;
  listenerInstalled: boolean;
}

// Store state on the TUI so /reload reuses the listener instead of stacking
// stale listeners with separate module-level focus flags.
function focusState(tui: TUI): FocusState {
  const holder = tui as unknown as { __cursorFocus?: FocusState };
  if (!holder.__cursorFocus) {
    holder.__cursorFocus = { focused: true, listenerInstalled: false };
  }
  return holder.__cursorFocus;
}

class FocusAwareEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    const state = focusState(tui);

    // Re-enable after every extension load; reload teardown may reset terminal
    // modes while the TUI-attached listener remains installed.
    process.stdout.write("\x1b[?1004h");

    if (state.listenerInstalled) return;
    state.listenerInstalled = true;

    tui.addInputListener((data: string) => {
      if (!data.includes("\x1b[I") && !data.includes("\x1b[O")) return;

      // Last focus token in a batched input chunk wins.
      state.focused = data.lastIndexOf("\x1b[I") > data.lastIndexOf("\x1b[O");
      const cleaned = data.split("\x1b[I").join("").split("\x1b[O").join("");

      // Focus changes do not otherwise invalidate the editor, so force a frame.
      tui.requestRender(true);
      return cleaned.length === 0 ? { consume: true } : { data: cleaned };
    });
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (focusState(this.tui).focused) return lines;
    return lines.map((line) => line.replace(FAKE_CURSOR, "$1"));
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
    process.stdout.write("\x1b[?1004l");
  });
}
