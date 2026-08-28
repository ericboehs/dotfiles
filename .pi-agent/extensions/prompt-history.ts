// Shell-style prompt history shared by every pi on the machine.
//
// pi's own history is per-process: pi-tui's Editor keeps the last 100 submitted
// prompts in memory and throws them away on exit, so a fresh pi starts with an
// empty ring and Up does nothing. This mirrors bash HISTFILE instead — every
// prompt is appended to one JSONL file, and each new editor is seeded from the
// tail of that file, so Up walks prompts typed in other panes, other repos and
// yesterday's sessions.
//
//   ${PI_CODING_AGENT_DIR:-~/.pi/agent}/prompt-history.jsonl
//   {"t":1764259200000,"cwd":"/Users/x/Code/foo","text":"fix the flaky test"}
//
// Speed is the whole point of the file. The obvious implementation (see
// npm:pi-input-history and pi discussion #1496) mines past sessions instead:
// SessionManager.list(cwd) streams and JSON.parses every line of every session
// JSONL in the project, then SessionManager.open().getEntries() parses the
// recent ones a second time. That is ~70ms per 100k lines of session log, twice,
// on a blocking session_start handler — a few hundred milliseconds of boot for
// a hundred strings. Reading the last 256KB of a purpose-built file is ~1ms and
// does not grow with how much the sessions have been used.
//
// Two hooks, both cheap:
//
//   input         append the submitted prompt (one write, no parsing)
//   session_start install an editor factory that seeds history from the tail
//
// Between seeds, a pi only knows what existed when it booted, so the editor's
// handleInput is wrapped to re-read the bytes appended since (a stat, and a read
// only when the size moved) on the first Up of a browse — that is what makes
// prompts from a pi still running in another pane show up here.
//
// @see .pi-agent/test/prompt-history.test.mjs

import {
  appendFileSync,
  closeSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CustomEditor, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

/**
 * "project-first" ranks prompts typed in this cwd ahead of everything else, so
 * Up in a repo walks that repo's prompts and falls through to the rest of the
 * machine. "recent" is strict bash-style recency across all projects.
 */
const SCOPE: "project-first" | "recent" = "project-first";

/** pi-tui's Editor caps its ring at 100, so seeding more than that is wasted work. */
const SEED_MAX = 100;

/** How far back to look for those 100 prompts. ~2000 records; ~1ms to parse. */
const TAIL_BYTES = 256 * 1024;

/** Trim the file once it passes this, keeping the newest KEEP_BYTES. */
const MAX_FILE_BYTES = 1024 * 1024;
const KEEP_BYTES = 512 * 1024;

/**
 * Bare slash commands ("/model", "/tree") are noise in a cross-session ring:
 * they are three keystrokes plus autocomplete to retype, and they would crowd
 * out real prompts. Anything with an argument ("/export foo.html") is kept.
 */
const BARE_COMMAND = /^\/[\w:.-]*$/;

/** Marks our editor factory so /reload rewraps the base instead of stacking. */
const WRAPPED = "__promptHistoryBase";

type Record_ = { t?: number; cwd?: string; text?: unknown };

/** EditorFactory is not re-exported from the package root, so recover it here. */
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type TaggedFactory = EditorFactory & { [WRAPPED]?: EditorFactory | null };

export default function promptHistory(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "prompt-history.jsonl");

  // Bytes of the file already reflected in the editor ring, and the texts that
  // got there (seeded, typed here, or picked up from another pi). Both exist to
  // keep refresh() from re-adding what is already in the ring.
  let offset = 0;
  let seen = new Set<string>();
  let editor: EditorComponent | undefined;

  /**
   * Pull in whatever other pis appended since the last look.
   *
   * A stat is ~microseconds and the common case stops there; when the file did
   * move, only the new bytes are read, and they always start on a record
   * boundary because offset is only ever set to a whole-file size.
   */
  const refresh = () => {
    if (!editor) return;
    const size = fileSize(path);
    if (size === offset) return;
    if (size < offset) {
      // Someone rotated the file. The ring already holds those prompts.
      offset = size;
      return;
    }
    const chunk = readRange(path, offset, size);
    offset = size;
    if (!chunk) return;
    for (const text of texts(chunk, false)) {
      if (seen.has(text)) continue;
      seen.add(text);
      editor.addToHistory?.(text);
    }
  };

  const append = (text: string, cwd: string) => {
    // Read before writing: this is the one moment we know the ring is about to
    // gain an entry, so it is also the cheapest place to fold in the other pis'
    // prompts and keep them in true chronological order behind our own.
    refresh();
    try {
      appendFileSync(path, `${JSON.stringify({ t: Date.now(), cwd, text })}\n`);
      seen.add(text);
      offset = fileSize(path);
      rotate(path, () => {
        offset = fileSize(path);
      });
    } catch {
      // A history file that cannot be written is not worth an error in the TUI.
    }
  };

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    // "extension" is injected prompts, "rpc" is programmatic; neither is
    // something the user would reach for with Up.
    if (event.source !== "interactive") return;
    const text = event.text.trim();
    if (!text || BARE_COMMAND.test(text)) return;
    append(text, ctx.cwd);
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Unwrap any factory of ours from a previous load: /reload runs this again
    // with a fresh module, and chaining our own wrapper would seed twice.
    let previous = ctx.ui.getEditorComponent();
    while (previous && WRAPPED in previous) {
      previous = (previous as TaggedFactory)[WRAPPED] ?? undefined;
    }

    const factory: EditorFactory = (tui, theme, keybindings) => {
      const component =
        previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);

      // Seed here rather than in session_start so that a second editor (a TUI
      // mode switch, another extension rebuilding the chain) also gets current
      // history, and so the byte offset is taken at the same instant.
      const { items, size } = readSeed(path, ctx.cwd);
      offset = size;
      seen = new Set(items);
      // addToHistory unshifts, so feed oldest first to land items[0] under Up.
      for (let i = items.length - 1; i >= 0; i--) component.addToHistory?.(items[i]!);

      editor = component;
      watchForBrowse(component, keybindings, refresh);
      return component;
    };
    (factory as TaggedFactory)[WRAPPED] = previous ?? null;

    ctx.ui.setEditorComponent(factory);
  });
}

/**
 * Refresh on the first Up of a browse.
 *
 * Wrapping the instance rather than subclassing keeps this compatible with
 * whatever editor the rest of the chain produced (cursor-focus.ts, a modal
 * editor, ...) — there is no class to extend when the previous factory returns
 * something of its own. The guard matters because addToHistory unshifts:
 * inserting entries mid-browse would shift the index the editor is holding, so
 * new prompts are only folded in when a browse starts, never during one.
 */
function watchForBrowse(
  component: EditorComponent,
  keybindings: KeybindingsManager,
  refresh: () => void,
): void {
  const handleInput = component.handleInput.bind(component);
  let browsing = false;
  component.handleInput = (data: string) => {
    const older =
      keybindings.matches(data, "tui.editor.cursorUp") ||
      keybindings.matches(data, "tui.editor.historyPrevious");
    const newer =
      keybindings.matches(data, "tui.editor.cursorDown") ||
      keybindings.matches(data, "tui.editor.historyNext");
    if (older && !browsing) refresh();
    browsing = older || newer;
    handleInput(data);
  };
}

/** Newest-first prompts to seed a new editor with, and the size they were read at. */
function readSeed(path: string, cwd: string): { items: string[]; size: number } {
  const size = fileSize(path);
  if (size === 0) return { items: [], size: 0 };

  const start = Math.max(0, size - TAIL_BYTES);
  const chunk = readRange(path, start, size);
  if (chunk === null) return { items: [], size };

  const project: string[] = [];
  const other: string[] = [];
  const unique = new Set<string>();

  const all = texts(chunk, start > 0, true);
  for (let i = all.length - 1; i >= 0; i--) {
    const [text, recordCwd] = all[i]!;
    if (unique.has(text)) continue;
    unique.add(text);
    const bucket = SCOPE === "project-first" && recordCwd !== cwd ? other : project;
    if (bucket.length < SEED_MAX) bucket.push(text);
    if (project.length >= SEED_MAX && (SCOPE !== "project-first" || other.length >= SEED_MAX)) {
      break;
    }
  }

  return { items: [...project, ...other].slice(0, SEED_MAX), size };
}

/** Parse JSONL, dropping the leading fragment when the read started mid-file. */
function texts(chunk: string, dropPartial: boolean): string[];
function texts(chunk: string, dropPartial: boolean, withCwd: true): [string, string | undefined][];
function texts(chunk: string, dropPartial: boolean, withCwd?: true): unknown[] {
  const lines = chunk.split("\n");
  if (dropPartial) lines.shift();
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line) continue;
    let record: Record_;
    try {
      record = JSON.parse(line) as Record_;
    } catch {
      // Torn concurrent write or hand editing: one bad line is not a reason to
      // lose the rest of the history.
      continue;
    }
    const text = record?.text;
    if (typeof text !== "string" || !text) continue;
    out.push(withCwd ? [text, typeof record.cwd === "string" ? record.cwd : undefined] : text);
  }
  return out;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readRange(path: string, start: number, end: number): string | null {
  const length = end - start;
  if (length <= 0) return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Keep the file bounded. Writing a temp file and renaming keeps readers whole;
 * a pi that appends during the rename writes to the replaced inode and loses
 * that one prompt, which is the accepted cost of not taking a lock on every
 * keystroke-sized write.
 */
function rotate(path: string, onRotated: () => void): void {
  const size = fileSize(path);
  if (size <= MAX_FILE_BYTES) return;
  const chunk = readRange(path, size - KEEP_BYTES, size);
  if (!chunk) return;
  const cut = chunk.indexOf("\n");
  if (cut < 0) return;
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, chunk.slice(cut + 1));
    renameSync(temp, path);
    onRotated();
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
  }
}
