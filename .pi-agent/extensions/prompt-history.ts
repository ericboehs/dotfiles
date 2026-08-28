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
// Two hooks and a shortcut, all cheap:
//
//   input         append the submitted prompt (one write, no parsing)
//   session_start install an editor factory that seeds history from the tail
//   ctrl+r        fuzzy search the file, bash reverse-i-search style
//
// Between seeds, a pi only knows what existed when it booted, so the editor's
// handleInput is wrapped to re-read the bytes appended since (a stat, and a read
// only when the size moved) on the first Up of a browse — that is what makes
// prompts from a pi still running in another pane show up here.
//
// The Ctrl+R overlay follows npm:pi-input-history, which follows
// mrshu/pi-readline-search; this one searches the same JSONL file rather than
// mining sessions, and shows a list instead of one match at a time.
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
import { basename, join } from "node:path";
import { CustomEditor, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorComponent,
  type Focusable,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";

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

/** Ctrl+R is bash muscle memory; keybindings.json moves /rename out of the way. */
const SEARCH_KEY: KeyId = "ctrl+r";

/** Matches shown around the selected one. Enough to scan, small enough to skim. */
const SEARCH_ROWS = 7;

/** Search reads deeper than the Up ring: it is a keypress, not startup. */
const SEARCH_BYTES = 1024 * 1024;
const SEARCH_MAX = 2000;

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

  pi.registerShortcut(SEARCH_KEY, {
    description: "Search prompt history",
    handler: async (ctx) => {
      // Read fresh rather than reusing the seed: search wants more than the 100
      // entries the editor ring can hold, and this session's own prompts are
      // already in the file.
      const entries = readSearchable(path);
      if (entries.length === 0) {
        ctx.ui.notify("No prompt history yet.", "info");
        return;
      }

      const picked = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => new SearchOverlay(tui, theme, entries, ctx.cwd, done),
        { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } },
      );

      if (picked) ctx.ui.setEditorText(picked);
    },
  });
}

type Entry = { text: string; cwd?: string };

/**
 * The search overlay: a filtered list over the history file.
 *
 * Deliberately not built on pi-tui's Input — the query is a plain string here,
 * which keeps the cursor, the counter and the match list to one line each and
 * avoids a second component to keep focus in sync with.
 */
class SearchOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: ExtensionUIContext["theme"];
  private readonly entries: Entry[];
  private readonly cwd: string;
  private readonly done: (result: string | undefined) => void;

  private query = "";
  private matches: Entry[];
  private selected = 0;

  constructor(
    tui: TUI,
    theme: ExtensionUIContext["theme"],
    entries: Entry[],
    cwd: string,
    done: (result: string | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.entries = entries;
    this.cwd = cwd;
    this.done = done;
    this.matches = entries;
  }

  handleInput(data: string): void {
    // Older is down the list, the direction Ctrl+R walks in a shell.
    if (matchesKey(data, SEARCH_KEY) || matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.move(1);
    } else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.move(-1);
    } else if (matchesKey(data, "enter")) {
      this.done(this.matches[this.selected]?.text);
      return;
    } else if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+g") ||
      matchesKey(data, "ctrl+c")
    ) {
      this.done(undefined);
      return;
    } else if (matchesKey(data, "backspace")) {
      this.setQuery(this.query.slice(0, -1));
    } else if (matchesKey(data, "ctrl+u")) {
      this.setQuery("");
    } else if (matchesKey(data, "ctrl+w")) {
      this.setQuery(this.query.replace(/\s*\S*$/, ""));
    } else if (isPrintable(data)) {
      this.setQuery(this.query + data);
    }
    this.tui.requestRender();
  }

  private setQuery(query: string): void {
    this.query = query;
    this.matches = query
      ? this.entries.filter((entry) => fuzzyMatch(entry.text, query))
      : this.entries;
    this.selected = 0;
  }

  private move(direction: number): void {
    if (this.matches.length === 0) return;
    this.selected = (this.selected + direction + this.matches.length) % this.matches.length;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    // Keep the selection inside a fixed window so the list does not jump.
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(SEARCH_ROWS / 2), this.matches.length - SEARCH_ROWS),
    );
    const shown = this.matches.slice(start, start + SEARCH_ROWS);

    if (shown.length === 0) lines.push(theme.fg("warning", "  no match"));
    for (const [offset, entry] of shown.entries()) {
      lines.push(this.renderEntry(entry, start + offset === this.selected, width));
    }

    const counter = this.matches.length > 0 ? `${this.selected + 1}/${this.matches.length}` : "0/0";
    const query = `${theme.fg("accent", "search ")}${theme.fg("text", this.query)}${
      this.focused ? CURSOR_MARKER : ""
    }`;
    const gap = Math.max(1, width - visibleWidth(query) - counter.length);
    lines.push(`${query}${" ".repeat(gap)}${theme.fg("dim", counter)}`);
    lines.push(
      truncateToWidth(
        theme.fg("dim", "ctrl+r/↓ older · ↑ newer · enter accept · esc cancel"),
        width,
      ),
    );
    return lines;
  }

  invalidate(): void {
    // Nothing is cached between renders; the list is rebuilt from `matches`.
  }

  private renderEntry(entry: Entry, isSelected: boolean, width: number): string {
    const theme = this.theme;
    const marker = isSelected ? theme.fg("accent", "▸ ") : "  ";

    // A prompt from another project is worth knowing about before running it
    // again, so the repo name rides along on the right.
    const elsewhere = entry.cwd && entry.cwd !== this.cwd ? ` ${basename(entry.cwd)}` : "";
    const lineCount = entry.text.split("\n").length;
    const suffix = `${lineCount > 1 ? ` ⏎${lineCount}` : ""}${elsewhere}`;

    const room = Math.max(10, width - 2 - suffix.length);
    const preview = truncateToWidth(entry.text.replace(/\s+/g, " ").trim(), room);
    const body = isSelected ? highlight(preview, this.query, theme) : theme.fg("muted", preview);

    return `${marker}${body}${theme.fg("dim", suffix)}`;
  }
}

/** Every whitespace-separated token must appear, in order, as a subsequence. */
function fuzzyMatch(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => {
      let at = 0;
      for (const char of token) {
        at = haystack.indexOf(char, at) + 1;
        if (at === 0) return false;
      }
      return true;
    });
}

/** Accent the characters the query matched, so it is obvious why a row is here. */
function highlight(text: string, query: string, theme: ExtensionUIContext["theme"]): string {
  if (!query) return theme.fg("text", text);

  const lower = text.toLowerCase();
  const hits = new Set<number>();
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let at = 0;
    for (const char of token) {
      const found = lower.indexOf(char, at);
      if (found === -1) break;
      hits.add(found);
      at = found + 1;
    }
  }

  let out = "";
  for (let i = 0; i < text.length; ) {
    const hit = hits.has(i);
    let j = i;
    while (j < text.length && hits.has(j) === hit) j++;
    const chunk = text.slice(i, j);
    out += hit ? theme.fg("accent", chunk) : theme.fg("text", chunk);
    i = j;
  }
  return out;
}

/** Printable text, as opposed to an escape sequence or a control character. */
function isPrintable(data: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: telling keys from text is the point
  return data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data);
}

/** Newest-first, deduplicated prompts for the search overlay. */
function readSearchable(path: string): Entry[] {
  const size = fileSize(path);
  if (size === 0) return [];
  const start = Math.max(0, size - SEARCH_BYTES);
  const chunk = readRange(path, start, size);
  if (chunk === null) return [];

  const all = texts(chunk, start > 0, true);
  const entries: Entry[] = [];
  const unique = new Set<string>();
  for (let i = all.length - 1; i >= 0 && entries.length < SEARCH_MAX; i--) {
    const [text, cwd] = all[i]!;
    if (unique.has(text)) continue;
    unique.add(text);
    entries.push({ text, cwd });
  }
  return entries;
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
