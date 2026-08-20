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
  private readonly hardwareCursorTui: TUI;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.hardwareCursorTui = tui;
    tui.setShowHardwareCursor(true);
  }

  render(width: number): string[] {
    // On /reload pi fires session_start (which reinstalls this editor and turns
    // the hardware cursor on) and only afterwards runs applyRuntimeSettings(),
    // which resets the hardware cursor to the settings default. That would leave
    // no cursor at all: the fake reverse-video cursor is stripped below while the
    // hardware cursor is off. Re-assert it every render so the native cursor
    // survives a reload. setShowHardwareCursor early-returns when unchanged, so
    // this is idempotent and only triggers a render on the frame it flips back on.
    this.hardwareCursorTui.setShowHardwareCursor(true);
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
