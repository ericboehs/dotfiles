/**
 * /1 /2 /3 — type out the next step the assistant just offered.
 *
 * Every reply here ends with a numbered "Next steps:" block (see the response
 * style rule in AGENTS.md), and the answer to it is almost always "do the
 * second one". Typing that out again — or scrolling up to copy it — is the
 * slowest part of an otherwise fast loop, and paraphrasing it ("do 2") throws
 * away the sentence that made the option worth picking.
 *
 *   /2          puts step 2 in the editor, verbatim
 *   /13         step 1, then AND, then step 3
 *   /2 but ssh  step 2 with the extra instruction appended
 *
 * It expands rather than sends. The step lands in the editor as ordinary text,
 * where it can be trimmed, argued with, or abandoned with Ctrl+C; Enter sends
 * it like anything else. Both routes end in the same place: Tab or Enter on the
 * completion rewrites the line in the editor, and submitting "/2" outright is
 * swallowed by the input handler, which refills the editor instead of prompting.
 *
 * Any digit string works, in any order: the digits are read left to right and
 * de-duplicated, so /31 leads with step 3. Ten-or-more-step lists are the one
 * ambiguity — there /12 means step 12, not steps 1 and 2 — but a reply with ten
 * next steps has bigger problems.
 *
 * The steps come from the newest assistant message on the current branch that
 * actually has a numbered list, looking back at most LOOKBACK messages, so a
 * one-line answer in between ("yes, that's the right port") does not lose the
 * menu. Reaching back is announced, because sending a stale step by accident is
 * worse than typing one out.
 *
 * ## Why an input handler *and* a completion
 *
 * The completion is the fast path: `/1` then Tab, and the text is there before
 * Enter is ever pressed. The input handler is the backstop for every way the
 * popup can be missing — pasted text, Escape, a terminal that ate the Tab — and
 * it is the only path that can honour trailing arguments, since the completion
 * fires while the line is still just digits.
 *
 * ## Why the input event and not registered commands
 *
 * `pi.registerCommand("1", …)` would have to be registered for every reachable
 * permutation (15 for a three-step list, 85 for five) at load time, before any
 * reply exists to be numbered. The `input` event sees the raw text before skill
 * and template expansion, so one regex covers every combination, and returning
 * `{ action: "transform" }` makes the expansion the user's own message rather
 * than something an extension said on their behalf.
 *
 * The cost is discovery: extension commands appear in the `/` menu, and this
 * does not. Hence the autocomplete provider, which is also the better help
 * text — it shows the step itself, not "select next step 2".
 *
 * ## The prefix is reported without its slash
 *
 * pi's editor applies the highlighted completion when Enter is pressed and then
 * *submits* it, but only when the autocomplete prefix starts with a slash (see
 * Editor.handleInput's tui.select.confirm branch — it is what makes Enter on
 * `/mod` run `/model`). Reporting the prefix as "13" rather than "/13" opts out
 * of that fall-through, so Enter expands into the editor and stops, which is the
 * whole point of the feature. It also makes pi's own highlight logic land on the
 * right row: it compares the prefix against item values, and "13" matches the
 * item whose value is "13" where "/13" matched nothing.
 *
 * The exact typed selection is emitted first anyway, and an invalid one emits
 * nothing at all: no popup, Enter submits the raw text, and the input handler
 * below explains what went wrong instead of the model receiving "/9".
 *
 * @see .pi-agent/test/next-steps.test.mjs
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Joins two picked steps. Capitalised on purpose: it reads as an instruction. */
const AND = "\n\nAND\n\n";

/** How many assistant messages back to look for a numbered list. */
const LOOKBACK = 3;

/** Width of the step preview shown in the autocomplete dropdown. */
const PREVIEW = 140;

/** `/13`, `/2 with more instructions`. Trailing space is what completion inserts. */
const INVOCATION_RE = /^\/(\d{1,4})(?:[ \t]+([\s\S]+?))?[ \t]*$/;

/** "Next steps:", "**Next steps**", "### Next steps" — the last one in a reply wins. */
const HEADING_RE = /^[ \t>*_#]*next steps\b[^\n]*$/gim;

/** " 1. text", "2) text" — up to six columns of indent, since replies indent the block. */
const ITEM_RE = /^[ \t]{0,6}(\d{1,2})[.)][ \t]+(\S.*)$/;

export interface NextSteps {
  /** The numbered steps, in order, one string each. */
  steps: string[];
  /** 0 when they came from the newest assistant message, 1 from the one before it. */
  age: number;
}

/** Text after the last "Next steps" heading, or "" when the reply has none. */
function headingBody(text: string): string {
  let start = -1;
  for (const match of text.matchAll(HEADING_RE)) {
    if (match.index !== undefined) start = match.index + match[0].length;
  }
  return start < 0 ? "" : text.slice(start);
}

/** Fallback for unheaded replies: the last block that starts over at "1.". */
function lastListBody(text: string): string {
  const lines = text.split("\n");
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]{0,6}1[.)][ \t]+\S/.test(lines[i] ?? "")) first = i;
  }
  return first < 0 ? "" : lines.slice(first).join("\n");
}

/**
 * Numbered items out of one block of Markdown.
 *
 * Items are only taken in sequence (1, then 2, then 3), which is what keeps a
 * "2025." or a nested list inside item 3 from starting a phantom item four.
 * Continuation lines are unwrapped into one paragraph: the model hard-wraps its
 * own output, and those line breaks are an artifact of the terminal width, not
 * of the instruction. The list ends at the first unindented line after a blank
 * one, so the "which do you want?" sentence underneath stays out of it.
 */
function collect(body: string): string[] {
  const items: string[][] = [];
  let expected = 1;
  let blank = false;

  for (const line of body.split("\n")) {
    const marker = ITEM_RE.exec(line);
    if (marker && Number(marker[1]) === expected) {
      items.push([marker[2]!.trim()]);
      expected += 1;
      blank = false;
      continue;
    }

    const current = items[items.length - 1];
    if (!current) continue;

    if (line.trim() === "") {
      blank = true;
      continue;
    }
    if (blank && !/^[ \t]{2,}/.test(line)) break;

    current.push(line.trim());
    blank = false;
  }

  return items
    .map((parts) => parts.join(" ").replace(/\s+/g, " ").trim())
    .filter((step) => step.length > 0);
}

/** The numbered next steps in one assistant reply, or [] when it offered none. */
export function parseNextSteps(text: string): string[] {
  const headed = headingBody(text);
  if (headed) {
    const steps = collect(headed);
    if (steps.length > 0) return steps;
  }
  const body = lastListBody(text);
  return body ? collect(body) : [];
}

/**
 * Digits typed after the slash to step indices, or null when they do not fit.
 *
 * Left to right, de-duplicated, order preserved: "31" is step 3 then step 1,
 * "11" is just step 1. A list with ten or more steps reads the digits as one
 * number instead, since /12 can only mean step 12 there.
 */
export function resolveSelection(token: string, count: number): number[] | null {
  if (count <= 0 || token.length === 0) return null;

  if (count >= 10) {
    const whole = Number(token);
    if (Number.isInteger(whole) && whole >= 1 && whole <= count) return [whole];
  }

  const picks: number[] = [];
  for (const char of token) {
    const n = Number(char);
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    if (!picks.includes(n)) picks.push(n);
  }
  return picks.length > 0 ? picks : null;
}

/** The message actually sent: the picked steps, plus anything typed after them. */
export function buildPrompt(steps: string[], picks: number[], extra = ""): string {
  const body = picks.map((n) => steps[n - 1] ?? "").join(AND);
  const trailer = extra.trim();
  return trailer ? `${body}\n\n${trailer}` : body;
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
}

/**
 * Dropdown entries for the digits typed so far.
 *
 * The exact selection comes first, then one entry per step not already picked,
 * so "/1" offers "/12" and "/13" and "/2" offers "/21" and "/23". Nothing is
 * offered for digits that do not resolve — an empty list closes the popup rather
 * than proposing a fix.
 */
export function completionItems(steps: string[], typed: string): AutocompleteItem[] {
  const count = steps.length;
  const describe = (value: string, picks: number[]): AutocompleteItem => ({
    value,
    label: value,
    description: preview(picks.map((n) => steps[n - 1] ?? "").join(" AND ")),
  });

  const picked = typed === "" ? null : resolveSelection(typed, count);
  if (typed !== "" && !picked) return [];

  const items: AutocompleteItem[] = [];
  if (picked) items.push(describe(typed, picked));

  for (let n = 1; n <= Math.min(count, 9); n++) {
    if (picked?.includes(n)) continue;
    const combo = `${typed}${n}`;
    const picks = resolveSelection(combo, count);
    if (picks) items.push(describe(combo, picks));
  }
  return items;
}

export default function nextSteps(pi: ExtensionAPI) {
  // Keyed on the newest assistant entry, because getSuggestions runs on every
  // keystroke inside a slash command and the answer only changes per reply.
  let cache: { id: string; found: NextSteps | undefined } | undefined;

  const findSteps = (ctx: ExtensionContext): NextSteps | undefined => {
    const replies: { id: string; text: string }[] = [];
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0 && replies.length < LOOKBACK; i--) {
      const entry = branch[i];
      if (!entry || entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "assistant") continue;
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      if (text.trim()) replies.push({ id: entry.id, text });
    }

    const newest = replies[0];
    if (!newest) return undefined;
    if (cache?.id === newest.id) return cache.found;

    let found: NextSteps | undefined;
    for (let age = 0; age < replies.length; age++) {
      const steps = parseNextSteps(replies[age]!.text);
      if (steps.length > 0) {
        found = { steps, age };
        break;
      }
    }
    cache = { id: newest.id, found };
    return found;
  };

  pi.on("input", async (event, ctx) => {
    // Messages this or another extension injected are not someone typing "/2".
    if (event.source === "extension") return;
    const match = INVOCATION_RE.exec(event.text);
    if (!match) return;

    const digits = match[1]!;
    const extra = match[2] ?? "";
    const say = (message: string, level: "info" | "warning") => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
    };

    const found = findSteps(ctx);
    if (!found) {
      say(`/${digits}: no numbered next steps in the last reply`, "warning");
      return { action: "handled" };
    }

    const picks = resolveSelection(digits, found.steps.length);
    if (!picks) {
      const n = found.steps.length;
      say(`/${digits}: the last reply offered ${n} next step${n === 1 ? "" : "s"}`, "warning");
      return { action: "handled" };
    }

    if (found.age > 0) {
      say(`Next steps taken from ${found.age + 1} replies back`, "info");
    }

    const text = buildPrompt(found.steps, picks, extra);
    // Expand, do not send: the step goes back in the editor to be edited or
    // abandoned. Safe here because pi's editor clears itself before it calls
    // onSubmit, so this lands after the clear rather than being wiped by it.
    if (ctx.hasUI) {
      ctx.ui.setEditorText(text);
      return { action: "handled" };
    }
    // No editor to expand into (print and JSON modes): send it.
    return { action: "transform", text };
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        // Slash commands only exist on the first line, at its start.
        if (cursorLine !== 0) return base;
        const typed = /^\/(\d*)$/.exec((lines[0] ?? "").slice(0, cursorCol));
        if (!typed) return base;

        const digits = typed[1]!;
        // Tab at a bare "/" is pi's "list the filesystem root" gesture; leave it.
        if (digits === "" && options.force) return base;

        const found = findSteps(ctx);
        if (!found) return base;
        const items = completionItems(found.steps, digits);
        if (items.length === 0) return base;

        // At a bare "/", pi's own commands stay first — Enter there must still
        // pick a command — and the steps hang off the end for discovery. Their
        // prefix keeps its slash, so picking one inserts "/1" and submits it,
        // and the input handler above does the expanding.
        if (digits === "" && base) return { prefix: base.prefix, items: [...base.items, ...items] };
        // Slash-less prefix: expand in place instead of submitting. See header.
        return { prefix: digits, items };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const fallback = () => current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        const line = lines[cursorLine] ?? "";
        // Ours only when the whole line so far is the invocation being completed.
        if (cursorLine !== 0 || !/^\d+$/.test(item.value)) return fallback();
        if (!/^\/\d*$/.test(line.slice(0, cursorCol))) return fallback();

        const found = findSteps(ctx);
        const picks = found ? resolveSelection(item.value, found.steps.length) : null;
        if (!found || !picks) return fallback();

        const expanded = buildPrompt(found.steps, picks).split("\n");
        const last = `${expanded[expanded.length - 1]}${line.slice(cursorCol)}`;
        const next = [...lines];
        next.splice(cursorLine, 1, ...expanded.slice(0, -1), last);
        return {
          lines: next,
          cursorLine: cursorLine + expanded.length - 1,
          cursorCol: (expanded[expanded.length - 1] ?? "").length,
        };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
