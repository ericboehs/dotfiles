/**
 * Tests for the Artificial Analysis model briefing extension.
 *
 * Runs the real extension against stub pi/ctx objects with a stubbed global
 * fetch, so no network and no real key is touched: withAgentDir sets a stub
 * ARTIFICIAL_ANALYSIS_API_KEY, which keeps the fnox fallback (this shell's
 * Keychain, absent on a CI runner) out of the picture entirely.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import aaInfo from "../extensions/aa-info.ts";

const SAMPLE = [
  {
    id: "2dad8957",
    name: "Claude Opus 5 (Adaptive Reasoning, Max Effort)",
    slug: "claude-opus-5",
    evaluations: {
      artificial_analysis_intelligence_index: 62.9,
      artificial_analysis_coding_index: 55.8,
    },
    pricing: { price_1m_blended_3_to_1: 10 },
    median_output_tokens_per_second: 153.831,
    median_time_to_first_token_seconds: 14.939,
  },
  {
    id: "opx",
    name: "Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)",
    slug: "claude-opus-5-xhigh",
    evaluations: {
      artificial_analysis_intelligence_index: 62.5,
      artificial_analysis_coding_index: 55,
    },
    pricing: { price_1m_blended_3_to_1: 10 },
    median_output_tokens_per_second: 151,
  },
  {
    id: "jkl",
    name: "Claude Opus 5 (Adaptive Reasoning, Low Effort)",
    slug: "claude-opus-5-low",
    evaluations: { artificial_analysis_intelligence_index: 52.5 },
    pricing: { price_1m_blended_3_to_1: 10 },
    median_output_tokens_per_second: 149,
  },
  {
    id: "def",
    name: "GPT-5.6",
    slug: "gpt-5-6",
    evaluations: {
      artificial_analysis_intelligence_index: 70.1,
      artificial_analysis_coding_index: 66,
    },
    pricing: { price_1m_blended_3_to_1: 4.5 },
    median_output_tokens_per_second: 200,
    median_time_to_first_token_seconds: 0.5,
  },
  {
    id: "mno",
    name: "GPT-5.6 (medium)",
    slug: "gpt-5-6-medium",
    evaluations: { artificial_analysis_intelligence_index: 64 },
    pricing: { price_1m_blended_3_to_1: 4.5 },
    median_output_tokens_per_second: 210,
  },
  {
    id: "ghi",
    name: "Kimi K3 (Reasoning) (max)",
    slug: "kimi-k3",
    evaluations: { artificial_analysis_intelligence_index: 60 },
    pricing: { price_1m_blended_3_to_1: 0.237 },
    median_output_tokens_per_second: 100,
    median_time_to_first_token_seconds: 1.18,
    median_time_to_first_answer_token: 41.971,
  },
];

// The cost endpoint carries an arbitrary one or two efforts per model: Opus at
// the xhigh this session runs, GPT-5.6 only at medium (a rung away), and Kimi
// under a bare slug with no effort ladder behind it. The model fixture includes
// Opus xhigh but no GPT-5.6 xhigh, proving data metrics choose an exact effort
// row and otherwise fall back to AA's bare/max row.
const COSTS = [
  {
    slug: "claude-opus-5-xhigh",
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 1.8012 } },
  },
  {
    slug: "claude-opus-5-low",
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.4252 } },
  },
  {
    slug: "gpt-5-6-medium",
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.1232 } },
  },
  {
    slug: "kimi-k3",
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.0869 } },
  },
];

// AA suffixes reasoning variants onto its names; the briefing strips them, so
// the sample carries them and the expectations do not. Latency is in the sample
// too, and deliberately absent from every expectation.
const OPUS_LINE = "Claude Opus 5 — int 62.5 · cod 55 · 151t/s · $10/1M · $1.80/task (AA)";

/** Run one test against a throwaway agent directory (the cache lives there). */
function withAgentDir(fn) {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), "pi-aa-info-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  // The extension fetches only once a key is in hand, resolved from this env
  // var and then fnox. A shell that has either passes while a CI runner —
  // which has neither — silently briefs nothing, and every test fails. The
  // fetch itself is stubbed, so a fixed stub key touches no real credential
  // and makes the suite hermetic rather than machine-dependent.
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = "stub-key-for-tests";
  return Promise.resolve(fn(dir)).finally(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousKey === undefined) delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    else process.env.ARTIFICIAL_ANALYSIS_API_KEY = previousKey;
  });
}

/** Stub global fetch, count calls, and restore afterwards. */
function withFetch(fn) {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    return fn(url, options, calls);
  };
  return {
    get count() {
      return calls;
    },
    restore() {
      globalThis.fetch = previous;
    },
  };
}

/** Serve both free endpoints: the model list, and the sparse cost list. */
const okFetch = () => async (url) => ({
  ok: true,
  status: 200,
  json: async () =>
    String(url).includes("/language/models/free")
      ? { status: 200, data: COSTS }
      : { status: 200, data: SAMPLE },
});

/** Both endpoints are fetched per refresh, so counts come in pairs. */
const FETCHES_PER_REFRESH = 2;

async function until(fn, ms = 1_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Mount the extension and return handles for driving events. */
function mount() {
  const notifies = [];
  const handlers = {};
  const pi = {
    on: (name, handler) => {
      handlers[name] = handler;
    },
  };
  aaInfo(pi);
  const ctx = {
    hasUI: true,
    model: { id: "claude-opus-5", provider: "github-copilot" },
    // Opus's cost is only listed under -xhigh, which is what this session runs.
    thinkingLevel: "xhigh",
    ui: {
      notify: (message, level) => {
        notifies.push({ message, level });
      },
    },
  };
  /** Switch exactly as pi does: the model is current before the event fires. */
  const fire = (model) => {
    ctx.model = model;
    return handlers.model_select({ model, source: "cycle" }, ctx);
  };
  return {
    notifies,
    fire,
    /** Fire session_start and wait for any briefing it produces. */
    start: async () => {
      await handlers.session_start({}, ctx);
      await until(() => notifies.length > 0);
    },
    /** Fire model_select and wait for the briefing (or its absence to settle). */
    select: async (model) => {
      const before = notifies.length;
      await fire(model);
      await until(() => notifies.length > before, 200);
    },
  };
}

function model(id, provider = "github-copilot") {
  return { id, provider };
}

test("briefs the model a session starts on, with attribution", async () => {
  await withAgentDir(async () => {
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.start();
      assert.deepEqual(ui.notifies, [{ message: OPUS_LINE, level: "info" }]);
      assert.equal(fetcher.count, FETCHES_PER_REFRESH);
    } finally {
      fetcher.restore();
    }
  });
});

test("briefs every switch, sharing a single fetch across models", async () => {
  await withAgentDir(async () => {
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.select(model("claude-opus-5"));
      assert.equal(ui.notifies.length, 1);
      // Landing on a model again re-briefs: the numbers are what the switch is
      // for, and a cycle that only passed through must not spend the briefing.
      await ui.select(model("claude-opus-5"));
      assert.equal(ui.notifies.length, 2);
      // A different model shares the one refresh (the API returns all models).
      await ui.select(model("moonshotai/Kimi-K3", "openrouter"));
      assert.equal(fetcher.count, FETCHES_PER_REFRESH);
      // Its own bare slug, and no effort ladder behind it, so nothing to mark.
      assert.match(
        ui.notifies[2].message,
        /^Kimi K3 — int 60 · 100t\/s · \$0\.24\/1M · \$0\.09\/task \(AA\)$/,
      );
      // Preset and variant suffixes are stripped before matching. GPT-5.6's
      // only measured effort is a rung below this session, so it is marked.
      await ui.select(model("gpt-5-6@preset/fast", "openrouter"));
      assert.match(
        ui.notifies[3].message,
        /^GPT-5\.6 — int 70\.1 · cod 66 · 200t\/s · \$4\.5\/1M · \$0\.12\/task@med \(AA\)$/,
      );
    } finally {
      fetcher.restore();
    }
  });
});

test("the briefing lands after the handler, where pi's switch status cannot bury it", async () => {
  await withAgentDir(async () => {
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.start();
      ui.notifies.length = 0;
      // pi prints "Switched to X" as soon as the handlers resolve, and its
      // showStatus() overwrites the previous status line instead of appending.
      // Painting inside that window would put the briefing under the switch
      // message, so nothing may be on screen when the handler returns.
      await ui.fire(model("moonshotai/Kimi-K3", "openrouter"));
      assert.equal(ui.notifies.length, 0, "nothing painted before pi's status");
      await until(() => ui.notifies.length === 1);
      assert.match(ui.notifies[0].message, /^Kimi K3 /);
    } finally {
      fetcher.restore();
    }
  });
});

test("models merely cycled past stay quiet; only the one landed on speaks", async () => {
  await withAgentDir(async () => {
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.start();
      ui.notifies.length = 0;
      // Three Ctrl+P presses in a row, faster than the lookups resolve.
      await Promise.all([
        ui.fire(model("claude-opus-5")),
        ui.fire(model("moonshotai/Kimi-K3", "openrouter")),
        ui.fire(model("gpt-5-6", "openrouter")),
      ]);
      await until(() => ui.notifies.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(
        ui.notifies.map((n) => n.message),
        ["GPT-5.6 — int 70.1 · cod 66 · 200t/s · $4.5/1M · $0.12/task@med (AA)"],
      );
    } finally {
      fetcher.restore();
    }
  });
});

test("fresh cache is used without a fetch; stale cache is refetched", async () => {
  await withAgentDir(async (dir) => {
    const cache = path.join(dir, "cache", "aa-models.json");
    const write = (fetchedAt) => {
      mkdirSync(path.dirname(cache), { recursive: true });
      writeFileSync(
        cache,
        JSON.stringify({ fetchedAt, data: SAMPLE, costs: { "claude-opus-5-xhigh": 1.8012 } }),
      );
    };

    // Fresh cache: no network at all.
    await write(Date.now());
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.start();
      assert.deepEqual(ui.notifies, [{ message: OPUS_LINE, level: "info" }]);
      assert.equal(fetcher.count, 0);
    } finally {
      fetcher.restore();
    }

    // Week-old cache: refetched, and the new briefing shows.
    await write(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const refetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.start();
      assert.deepEqual(ui.notifies, [{ message: OPUS_LINE, level: "info" }]);
      assert.equal(refetcher.count, FETCHES_PER_REFRESH);
    } finally {
      refetcher.restore();
    }
  });
});

test("a cache written before $/task existed is refreshed, not trusted", async () => {
  await withAgentDir(async (dir) => {
    const cache = path.join(dir, "cache", "aa-models.json");
    mkdirSync(path.dirname(cache), { recursive: true });
    // Fresh by timestamp, but from the version that only fetched the model list.
    writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), data: SAMPLE }));
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.start();
      assert.equal(fetcher.count, FETCHES_PER_REFRESH, "refetched for the costs");
      assert.deepEqual(ui.notifies, [{ message: OPUS_LINE, level: "info" }]);
    } finally {
      fetcher.restore();
    }
  });
});

test("a cost endpoint that fails costs only the $/task segment", async () => {
  await withAgentDir(async () => {
    const fetcher = withFetch(async (url) => {
      if (String(url).includes("/language/models/free")) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ status: 200, data: SAMPLE }) };
    });
    try {
      const ui = mount();
      await ui.start();
      assert.deepEqual(ui.notifies, [
        {
          // The main list is effort-aware even when the $/task endpoint fails.
          message: "Claude Opus 5 — int 62.5 · cod 55 · 151t/s · $10/1M (AA)",
          level: "info",
        },
      ]);
    } finally {
      fetcher.restore();
    }
  });
});

test("models the API does not know stay silent", async () => {
  await withAgentDir(async () => {
    const fetcher = withFetch(okFetch());
    try {
      const ui = mount();
      await ui.select(model("Ornith-1.5-35B-A3B-MLX-4bit", "omlx"));
      assert.equal(ui.notifies.length, 0, "unknown model shows nothing");
      assert.equal(fetcher.count, FETCHES_PER_REFRESH, "the refresh still happened once");
    } finally {
      fetcher.restore();
    }
  });
});

test("a failed fetch is silent but retries on the next switch", async () => {
  await withAgentDir(async () => {
    // Its own agent dir: a cache left by another test (or block) would serve
    // this model without a fetch and the retry semantics would go untested.
    const failing = withFetch(async () => {
      throw new Error("offline");
    });
    try {
      const ui = mount();
      await ui.select(model("claude-opus-5"));
      assert.equal(ui.notifies.length, 0);
      // The failure is not remembered: the next switch tries again.
      await ui.select(model("claude-opus-5"));
      await until(() => failing.count === 2 * FETCHES_PER_REFRESH, 100);
      assert.equal(failing.count, 2 * FETCHES_PER_REFRESH);
      assert.equal(ui.notifies.length, 0);
    } finally {
      failing.restore();
    }
  });
});
