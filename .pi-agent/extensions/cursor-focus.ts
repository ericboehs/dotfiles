// Use the terminal's real cursor while pi's pane is focused and hide the cursor
// when the pane loses focus.
//
// pi normally hides the hardware cursor and draws a fake cursor by wrapping the
// character under it in reverse video. That fake block has pi's text color and
// remains painted in every tmux pane. This extension removes the fake block,
// enables pi-tui's hardware cursor on FocusIn, and hides it on FocusOut.
//
// Requires: tmux `set -g focus-events on`.

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const FAKE_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[0m/g;

interface FocusState {
  focused: boolean;
  listenerInstalled: boolean;
  onFocusChange?: (focused: boolean) => void;
}

// Store state and the listener on the TUI so /reload does not stack listeners.
// The callback is replaced on each load, allowing behavior changes without
// replacing the long-lived input listener.
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

    state.onFocusChange = (focused) => {
      tui.setShowHardwareCursor(focused);
      tui.requestRender(true);
    };

    // Re-enable after every extension load; reload teardown may reset terminal
    // modes while the TUI-attached listener remains installed.
    process.stdout.write("\x1b[?1004h");
    tui.setShowHardwareCursor(state.focused);

    if (state.listenerInstalled) return;
    state.listenerInstalled = true;

    tui.addInputListener((data: string) => {
      if (!data.includes("\x1b[I") && !data.includes("\x1b[O")) return;

      // Last focus token in a batched input chunk wins.
      state.focused = data.lastIndexOf("\x1b[I") > data.lastIndexOf("\x1b[O");
      state.onFocusChange?.(state.focused);

      const cleaned = data.split("\x1b[I").join("").split("\x1b[O").join("");
      return cleaned.length === 0 ? { consume: true } : { data: cleaned };
    });
  }

  render(width: number): string[] {
    // Preserve CURSOR_MARKER immediately before the fake block; pi-tui uses it
    // to position the real terminal cursor after the reverse-video span is gone.
    return super.render(width).map((line) => line.replace(FAKE_CURSOR, "$1"));
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
