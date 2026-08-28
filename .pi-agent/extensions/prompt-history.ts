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
//   {"t":1764259200000,"cwd":"/Users/x/Code/foo","s":"01JD…","text":"fix the flaky test"}
//
// Shared does not mean undifferentiated: the first Up has to be the prompt you
// yourself last sent, or the ring is worse than no ring. Every record carries
// the session that wrote it, and the ring is ordered this session's prompts,
// then this project's, then the machine's — so Up walks outwards from where you
// are standing rather than handing you whatever some other pane typed last.
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
// prompts from a pi still running in another pane show up here. Those arrivals
// are spliced in behind this session's own prompts (see foldIn) rather than
// unshifted on top of them.
//
// The Ctrl+R overlay follows npm:pi-input-history, which follows
// mrshu/pi-readline-search; this one searches the same JSONL file rather than
// mining sessions, matches literally instead of fuzzily, and shows a list
// instead of one match at a time.
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
 * How everything that is not this session's own gets ranked. "project-first"
 * puts prompts typed in this cwd ahead of the rest of the machine; "recent" is
 * strict bash-style recency across all projects. Prompts from this session come
 * before either, always — that is not a policy, it is what Up means.
 */
const SCOPE: "project-first" | "recent" = "project-first";

/** pi-tui's Editor caps its ring at 100, so seeding more than that is wasted work. */
const RING_MAX = 100;

/** How far back to look for those 100 prompts. ~2000 records; ~1ms to parse. */
const TAIL_BYTES = 256 * 1024;

/**
 * Trim the file once it passes this, keeping the newest KEEP_BYTES. At the
 * ~60KB/day this fills at, that is roughly a year of prompts kept and a rewrite
 * every couple of months.
 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const KEEP_BYTES = 12 * 1024 * 1024;

/** Ctrl+R is bash muscle memory; keybindings.json moves /rename out of the way. */
const SEARCH_KEY: KeyId = "ctrl+r";

/** Matches shown around the selected one. Enough to scan, small enough to skim. */
const SEARCH_ROWS = 7;

/**
 * Search reads the whole file, not a tail window: recall is the entire point,
 * and the cost is paid once per session (see readSearchable) rather than per
 * keypress. The entry cap bounds the memory the lowercased copies take.
 */
const SEARCH_BYTES = MAX_FILE_BYTES;
const SEARCH_MAX = 20000;

/**
 * Bare slash commands ("/model", "/tree") are noise in a cross-session ring:
 * they are three keystrokes plus autocomplete to retype, and they would crowd
 * out real prompts. Anything with an argument ("/export foo.html") is kept.
 */
const BARE_COMMAND = /^\/[\w:.-]*$/;

/** Marks our editor factory so /reload rewraps the base instead of stacking. */
const WRAPPED = "__promptHistoryBase";

type Record_ = { t?: number; cwd?: string; s?: unknown; text?: unknown };

/** One history record, as the readers care about it. */
type Parsed = { text: string; cwd?: string; session?: string };

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
  let editorTui: TUI | undefined;

  // Prompts this session sent, including the ones a resume brought back. pi
  // unshifts each of them as it is sent, so they are the front of the ring, and
  // knowing them is what lets foldIn slot other pis in underneath.
  const local = new Set<string>();
  let session: string | undefined;

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
    const fresh: string[] = [];
    for (const text of texts(chunk, false)) {
      if (seen.has(text)) continue;
      seen.add(text);
      fresh.push(text);
    }
    if (fresh.length > 0) foldIn(editor, fresh, local);
  };

  const append = (text: string, cwd: string) => {
    // Read before writing: this is the one moment we know the ring is about to
    // gain an entry, so it is also the cheapest place to fold in the other pis'
    // prompts and keep them in true chronological order behind our own.
    refresh();
    try {
      // JSON.stringify drops an undefined `s`, so an unidentifiable session
      // just writes the record it always wrote.
      appendFileSync(path, `${JSON.stringify({ t: Date.now(), cwd, s: session, text })}\n`);
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
    if (!text) return;
    // pi puts every submission in the ring, bare commands included, so they all
    // count as ours: the pinned prefix has to match what is actually in front.
    local.add(text);
    // A resume or a fork moves the session out from under us mid-run.
    session = sessionOf(ctx);
    if (BARE_COMMAND.test(text)) return;
    append(text, ctx.cwd);
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    session = sessionOf(ctx);

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
      const { items, mine, size } = readSeed(path, ctx.cwd, session);
      offset = size;
      seen = new Set(items);
      // On a resume these were typed in this session before the restart, so they
      // are ours to protect even though this process never saw them sent.
      for (const text of mine) local.add(text);
      // addToHistory unshifts, so feed oldest first to land items[0] under Up.
      for (let i = items.length - 1; i >= 0; i--) component.addToHistory?.(items[i]!);

      editor = component;
      editorTui = tui;
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

      if (picked) {
        ctx.ui.setEditorText(picked);
        // setEditorText goes straight to Editor.setText, which does not ask for
        // a frame; without this the recalled prompt sits invisible until the
        // next keystroke repaints the editor.
        editorTui?.requestRender();
      }
    },
  });
}

type Entry = { text: string; lower: string; cwd?: string };

/**
 * Parsed search corpus, newest first, and how far into the file it reflects.
 * Module scope rather than closure scope so /reload starts over: the file is
 * the source of truth and a fresh parse is only paid once per session.
 */
let searchCache: Entry[] = [];
let searchSeen = new Set<string>();
let searchOffset = 0;

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
  private matcher: Matcher = matchAll;
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
    this.matcher = buildMatcher(query, this.entries);
    const scored: { entry: Entry; score: number }[] = [];
    for (const entry of this.entries) {
      const score = this.matcher.score(entry.lower);
      if (score !== null) scored.push({ entry, score });
    }
    // Stable, so a literal search (every score 0) keeps recency order while a
    // loose one floats the tightest matches to the top.
    scored.sort((a, b) => a.score - b.score);
    this.matches = scored.map((match) => match.entry);
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
    // Say so when nothing matched literally and the search went loose, so a
    // scattered-looking result set is explained rather than baffling.
    const status = `${this.matcher.loose ? "fuzzy " : ""}${counter}`;
    const query = `${theme.fg("accent", "search ")}${theme.fg("text", this.query)}${
      this.focused ? CURSOR_MARKER : ""
    }`;
    const gap = Math.max(1, width - visibleWidth(query) - status.length);
    lines.push(`${query}${" ".repeat(gap)}${theme.fg("dim", status)}`);
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
    const body = isSelected
      ? highlight(preview, this.matcher, theme)
      : theme.fg("muted", preview);

    return `${marker}${body}${theme.fg("dim", suffix)}`;
  }
}

/**
 * How a query is matched against a prompt.
 *
 * Plain subsequence matching on its own is useless at this scale: "kamal"
 * happily matches any prompt with a k, an a, an m, an a and an l scattered
 * across two sentences, and the handful of prompts that actually say kamal end
 * up buried under hundreds of those. So every token has to appear literally,
 * and the loose match is only a fallback for when that finds nothing at all.
 */
type Matcher = {
  /**
   * null when the entry does not match, otherwise a rank where lower is better.
   * Takes the pre-lowercased text: this runs over 20k entries per keystroke.
   */
  score: (lower: string) => number | null;
  hits: (text: string) => Set<number>;
  loose: boolean;
};

const matchAll: Matcher = { score: () => 0, hits: () => new Set(), loose: false };

function buildMatcher(query: string, entries: Entry[]): Matcher {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return matchAll;

  const literal: Matcher = {
    score: (lower) => (tokens.every((token) => lower.includes(token)) ? 0 : null),
    hits: (text) => {
      const haystack = text.toLowerCase();
      const positions = new Set<number>();
      for (const token of tokens) {
        for (let at = haystack.indexOf(token); at !== -1; at = haystack.indexOf(token, at + 1)) {
          for (let i = 0; i < token.length; i++) positions.add(at + i);
        }
      }
      return positions;
    },
    loose: false,
  };
  if (entries.some((entry) => literal.score(entry.lower) !== null)) return literal;

  // The fallback is typo tolerance, not a wildcard: the letters have to land
  // near each other. Unbounded, "solar" matched 664 of 1657 real prompts by
  // finding an s, an o, an l, an a and an r strewn across a paragraph.
  return {
    score: (lower) => {
      let total = 0;
      for (const token of tokens) {
        const found = looseMatch(lower, token);
        if (found === null) return null;
        const span = found[found.length - 1]! - found[0]! + 1;
        if (span > token.length * 2 + 2) return null;
        total += span;
      }
      return total;
    },
    hits: (text) => {
      const haystack = text.toLowerCase();
      const positions = new Set<number>();
      for (const token of tokens) {
        for (const position of looseMatch(haystack, token) ?? []) positions.add(position);
      }
      return positions;
    },
    loose: true,
  };
}

/**
 * Where a token sits in the text as a subsequence, tightened: match forward
 * greedily to find an end, then walk backwards from there so the run is as
 * compact as the text allows. Null when a character is missing.
 */
function looseMatch(haystack: string, token: string): number[] | null {
  let at = 0;
  for (const char of token) {
    const found = haystack.indexOf(char, at);
    if (found === -1) return null;
    at = found + 1;
  }

  const positions = [at - 1];
  for (let i = token.length - 2; i >= 0; i--) {
    const found = haystack.lastIndexOf(token[i]!, positions[0]! - 1);
    if (found === -1) return null;
    positions.unshift(found);
  }
  return positions;
}

/** Accent the characters the query matched, so it is obvious why a row is here. */
function highlight(text: string, matcher: Matcher, theme: ExtensionUIContext["theme"]): string {
  const hits = matcher.hits(text);
  if (hits.size === 0) return theme.fg("text", text);

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

  // Parsing a year of prompts costs real milliseconds, so it happens once and
  // later opens only read whatever was appended since — by this pi or another.
  if (size < searchOffset || searchCache.length === 0) {
    const start = Math.max(0, size - SEARCH_BYTES);
    const chunk = readRange(path, start, size);
    searchOffset = size;
    if (chunk === null) return searchCache;

    const all = texts(chunk, start > 0, true);
    searchCache = [];
    searchSeen = new Set();
    for (let i = all.length - 1; i >= 0 && searchCache.length < SEARCH_MAX; i--) {
      const { text, cwd } = all[i]!;
      if (searchSeen.has(text)) continue;
      searchSeen.add(text);
      searchCache.push({ text, lower: text.toLowerCase(), cwd });
    }
    return searchCache;
  }

  if (size > searchOffset) {
    const chunk = readRange(path, searchOffset, size);
    searchOffset = size;
    if (chunk === null) return searchCache;
    for (const { text, cwd } of texts(chunk, false, true)) {
      if (searchSeen.has(text)) continue;
      searchSeen.add(text);
      searchCache.unshift({ text, lower: text.toLowerCase(), cwd });
    }
    if (searchCache.length > SEARCH_MAX) {
      for (const entry of searchCache.splice(SEARCH_MAX)) searchSeen.delete(entry.text);
    }
  }

  return searchCache;
}

/**
 * Refresh on the first Up of a browse.
 *
 * Wrapping the instance rather than subclassing keeps this compatible with
 * whatever editor the rest of the chain produced (cursor-focus.ts, a modal
 * editor, ...) — there is no class to extend when the previous factory returns
 * something of its own. The guard matters because the ring is spliced: folding
 * entries in mid-browse would shift the index the editor is holding, so new
 * prompts are only picked up when a browse starts, never during one.
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

/**
 * Add prompts the other pis wrote without letting them jump the queue.
 *
 * addToHistory unshifts, which is exactly backwards here: a prompt another pane
 * sent while you were reading would land under the first Up ahead of the one
 * you typed yourself, which is the whole complaint about a shared ring. pi-tui
 * keeps its history in a plain array, so splice the newcomers in behind this
 * session's own prompts instead — still one Up away, just not in front.
 */
function foldIn(editor: EditorComponent, fresh: string[], local: Set<string>): void {
  const ring = (editor as { history?: unknown }).history;
  if (!Array.isArray(ring)) {
    // Some other editor implementation: unshifting is all the interface offers.
    for (const text of fresh) editor.addToHistory?.(text);
    return;
  }

  // Our prompts are the prefix pi unshifted as they were sent (plus whatever a
  // resume seeded); the first entry we do not recognise is where the shared
  // history starts, and that is where the other pis belong.
  let at = 0;
  while (at < ring.length && local.has(ring[at] as string)) at++;

  fresh.reverse(); // texts() yields oldest first; the ring is newest first.
  ring.splice(at, 0, ...fresh);
  // splice bypasses the cap addToHistory enforces, so re-apply it.
  if (ring.length > RING_MAX) ring.length = RING_MAX;
}

/**
 * Which pi a prompt came from.
 *
 * The session id, not the pid: it survives a resume, so `pi -c` still knows
 * which prompts were its own and keeps them under Up ahead of whatever the rest
 * of the machine has been doing since.
 */
function sessionOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.() || undefined;
  } catch {
    // An ephemeral or half-built session is simply unidentified.
    return undefined;
  }
}

/**
 * Newest-first prompts to seed a new editor with, the ones this session sent,
 * and the size they were read at.
 */
function readSeed(
  path: string,
  cwd: string,
  session: string | undefined,
): { items: string[]; mine: string[]; size: number } {
  const size = fileSize(path);
  if (size === 0) return { items: [], mine: [], size: 0 };

  const start = Math.max(0, size - TAIL_BYTES);
  const chunk = readRange(path, start, size);
  if (chunk === null) return { items: [], mine: [], size };

  const mine: string[] = [];
  const project: string[] = [];
  const other: string[] = [];
  const unique = new Set<string>();

  const all = texts(chunk, start > 0, true);
  for (let i = all.length - 1; i >= 0; i--) {
    const record = all[i]!;
    if (unique.has(record.text)) continue;
    unique.add(record.text);
    const bucket =
      session !== undefined && record.session === session
        ? mine
        : SCOPE === "project-first" && record.cwd !== cwd
          ? other
          : project;
    if (bucket.length < RING_MAX) bucket.push(record.text);
    if (mine.length >= RING_MAX) break;
    if (project.length >= RING_MAX && (SCOPE !== "project-first" || other.length >= RING_MAX)) {
      break;
    }
  }

  return { items: [...mine, ...project, ...other].slice(0, RING_MAX), mine, size };
}

/** Parse JSONL, dropping the leading fragment when the read started mid-file. */
function texts(chunk: string, dropPartial: boolean): string[];
function texts(chunk: string, dropPartial: boolean, detailed: true): Parsed[];
function texts(chunk: string, dropPartial: boolean, detailed?: true): unknown[] {
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
    out.push(detailed ? { text, cwd: str(record.cwd), session: str(record.s) } : text);
  }
  return out;
}

/** A non-empty string field, or nothing. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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
