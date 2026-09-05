import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import progress, {
  compactionTreeKind,
  patchTreeSelector,
  relabelCompactionRow,
} from "../extensions/compaction-progress.ts";

async function withProgress(fn) {
  const home = await mkdtemp(join(tmpdir(), "pi-compaction-progress-test-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const handlers = new Map();
  const widgets = [];
  const ctx = {
    model: { id: "synthetic-model" },
    ui: {
      setWidget(_id, lines) { if (lines) widgets.push(lines); },
      theme: { fg: (_color, text) => text },
    },
  };
  try {
    progress({ on: (name, fn) => handlers.set(name, fn) });
    const start = () => handlers.get("session_before_compact")(
      { preparation: { tokensBefore: 100_000 }, signal: new AbortController().signal },
      ctx,
    );
    const compact = (details) => handlers.get("session_compact")(
      { compactionEntry: { type: "compaction", tokensBefore: 100_000, details } },
      ctx,
    );
    await fn({ handlers, ctx, widgets, start, compact, file: join(home, ".pi", "agent", "compaction-rates.json") });
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("checkpoint rollovers do not train the summarizer throughput estimate", async () => {
  await withProgress(async ({ start, compact, file }) => {
    await start();
    await compact({ kind: "window-mode/v1" });
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    await start();
    await compact();
    const rates = JSON.parse(await readFile(file, "utf8"));
    assert.equal(rates["synthetic-model"].length, 1);
  });
});

test("completion line says rolled over vs summarized, and rollovers do not paint a bar", async () => {
  await withProgress(async ({ start, compact, widgets }) => {
    await start();
    assert.equal(widgets.length, 0, "no summarizer bar on the same turn as a rollover");
    await compact({ kind: "window-mode/v1" });
    assert.match(widgets.at(-1)[0], /Rolled over from 100,000 tokens · no summarizer/);
    assert.doesNotMatch(widgets.at(-1)[0], /Summarized|est\.|over estimate/);
    await start();
    await compact();
    assert.match(widgets.at(-1)[0], /Summarized from 100,000 tokens in \d+s/);
    assert.doesNotMatch(widgets.at(-1)[0], /Rolled over/);
  });
});

test("compaction tree kind is rolled over only for window-mode/v1", () => {
  assert.equal(compactionTreeKind({ type: "compaction", details: { kind: "window-mode/v1" } }), "Rolled over");
  assert.equal(compactionTreeKind({ type: "compaction", details: { readFiles: [] } }), "Summarized");
  assert.equal(compactionTreeKind({ type: "compaction" }), "Summarized");
  assert.equal(compactionTreeKind({ type: "branch_summary" }), undefined);
  assert.equal(compactionTreeKind(undefined), undefined);
});

test("tree row text swaps compaction for rolled over vs summarized", () => {
  const ansi = (s) => `\x1b[36m${s}\x1b[0m`;
  const rolled = { type: "compaction", tokensBefore: 101_377, details: { kind: "window-mode/v1" } };
  const summarized = { type: "compaction", tokensBefore: 101_377 };
  assert.equal(
    relabelCompactionRow(ansi("[compaction: 101k tokens]"), rolled),
    ansi("[Rolled over: 101k tokens]"),
  );
  assert.equal(
    relabelCompactionRow(ansi("[compaction: 101k tokens]"), summarized),
    ansi("[Summarized: 101k tokens]"),
  );
  assert.equal(relabelCompactionRow("user: hello", rolled), "user: hello");
  assert.equal(relabelCompactionRow("[compaction: 101k tokens]", { type: "message" }), "[compaction: 101k tokens]");
});

test("/tree selector rows and search distinguish rollover vs summary", () => {
  class Parent {
    render(width) { return [`w${width}`]; }
  }
  class Fake extends Parent {
    constructor() {
      super();
      this.treeList = {
        getEntryDisplayText(node) {
          if (node?.entry?.type !== "compaction") return "user: hi";
          const tokens = Math.round(node.entry.tokensBefore / 1000);
          return `[compaction: ${tokens}k tokens]`;
        },
        getSearchableText(node) {
          return node?.entry?.type === "compaction" ? "compaction" : "user";
        },
      };
    }
  }
  assert.equal(patchTreeSelector(Fake), true);
  assert.equal(patchTreeSelector(Fake), true, "second patch is a no-op");
  const inst = new Fake();
  assert.deepEqual(inst.render(80), ["w80"]);
  const rolled = { entry: { type: "compaction", tokensBefore: 100_000, details: { kind: "window-mode/v1" } } };
  const summarized = { entry: { type: "compaction", tokensBefore: 100_000 } };
  assert.equal(inst.treeList.getEntryDisplayText(rolled), "[Rolled over: 100k tokens]");
  assert.equal(inst.treeList.getEntryDisplayText(summarized), "[Summarized: 100k tokens]");
  assert.equal(inst.treeList.getEntryDisplayText({ entry: { type: "message" } }), "user: hi");
  assert.match(inst.treeList.getSearchableText(rolled), /compaction Rolled over/);
  assert.match(inst.treeList.getSearchableText(summarized), /compaction Summarized/);
  assert.equal(inst.treeList.getSearchableText({ entry: { type: "message" } }), "user");
});
