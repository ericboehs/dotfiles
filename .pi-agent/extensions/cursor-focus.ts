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

// pi's fake cursor is reverse video around the grapheme under the cursor (or a
// space at end of input). CURSOR_MARKER precedes this sequence and is preserved.
const FAKE_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[0m/g;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Wrap whatever editor is already installed rather than replacing it: pi
    // discovers extensions in directory order, so an extension that also owns
    // the editor (prompt-history.ts) may register before or after this one, and
    // whoever ran last would otherwise silently drop the other.
    const previous = ctx.ui.getEditorComponent();

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      const render = editor.render.bind(editor);

      editor.render = (width: number) => {
        // On /reload pi fires session_start (which reinstalls this editor and
        // turns the hardware cursor on) and only afterwards runs
        // applyRuntimeSettings(), which resets the hardware cursor to the
        // settings default. That would leave no cursor at all: the fake
        // reverse-video cursor is stripped below while the hardware cursor is
        // off. Re-assert it every render so the native cursor survives a reload.
        // setShowHardwareCursor early-returns when unchanged, so this is
        // idempotent and only triggers a render on the frame it flips back on.
        tui.setShowHardwareCursor(true);
        return render(width).map((line) => line.replace(FAKE_CURSOR, "$1"));
      };

      tui.setShowHardwareCursor(true);
      return editor;
    });
  });
}
