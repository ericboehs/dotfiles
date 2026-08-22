import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Suppress the "Model scope: ..." startup line without hiding the pi banner.
 *
 * InteractiveMode.init() writes that line with a raw console.log *before* the
 * alt screen opens, so with tuiMode "fullscreen" it lingers in the main-screen
 * scrollback and shows up next to the resume hint after pi exits. The only
 * built-in switch for it is `quietStartup`, which also drops the version banner
 * and keybinding hints. This filters just that one line instead.
 *
 * Extension factories run before InteractiveMode.init(), so the patch is in
 * place by the time the line would be written. It uninstalls itself as soon as
 * it swallows the line (it is only ever printed once per session).
 */

const PATCH_FLAG = "__piQuietModelScopePatched";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const TARGET_PREFIX = "Model scope: ";

function isVerboseRun(): boolean {
  return process.argv.includes("--verbose") || process.argv.includes("-v");
}

export default function (_pi: ExtensionAPI): void {
  // `--verbose` prints the scope line on purpose; leave it alone.
  if (isVerboseRun()) return;

  const globalScope = globalThis as unknown as Record<string, boolean>;
  if (globalScope[PATCH_FLAG]) return;
  globalScope[PATCH_FLAG] = true;

  const originalLog = console.log;

  const restore = (): void => {
    if (console.log === filteredLog) console.log = originalLog;
    globalScope[PATCH_FLAG] = false;
  };

  const filteredLog = (...args: unknown[]): void => {
    const [first] = args;
    if (
      args.length === 1 &&
      typeof first === "string" &&
      first.replace(ANSI_PATTERN, "").startsWith(TARGET_PREFIX)
    ) {
      restore();
      return;
    }
    originalLog(...args);
  };

  console.log = filteredLog;
}
