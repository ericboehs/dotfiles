// Replace pi's fake reverse-video prompt cursor with the terminal's native
// hardware cursor.
//
// pi already emits CURSOR_MARKER at the correct editor position. Enabling the
// hardware cursor makes pi-tui position the terminal cursor at that marker;
// removing the fake reverse-video block prevents two cursors from overlapping.
// tmux and the terminal then provide their native focus behavior:
//
// - active tmux pane, focused terminal: normal hardware cursor
// - active tmux pane, unfocused terminal: terminal's inactive cursor style
// - inactive tmux pane: no cursor

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

// pi's fake cursor is reverse video around the grapheme under the cursor (or a
// space at end of input). CURSOR_MARKER precedes this sequence and is preserved.
const FAKE_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[0m/g;

class NativeCursorEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    tui.setShowHardwareCursor(true);
  }

  render(width: number): string[] {
    return super.render(width).map((line) => line.replace(FAKE_CURSOR, "$1"));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new NativeCursorEditor(tui, theme, keybindings),
    );
  });
}
