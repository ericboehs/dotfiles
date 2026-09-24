/**
 * Tests for the OpenCode Go usage parsers in provider-usage.ts.
 *
 * The chip prefers GET /zen/go/v1/usage (API key). The console status API
 * remains the cookie fallback. Both JSON shapes are pinned here.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatUsageCacheReport,
  opencodeGoCookieHeader,
  parseOpencodeGoStatus,
  parseOpencodeGoUsage,
  resolveUsageDriver,
  summarizeUsageCache,
} from "../extensions/provider-usage.ts";

// Shape of GET /console/api/go/status: microcents are bigints, so they arrive
// as JSON strings; `month` carries no rolling window of its own.
const FIXTURE = {
  subscriberUserID: "usr_01ABC",
  access: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
    meters: {
      fiveHour: {
        startsAt: "2026-09-19T10:00:00.000Z",
        resetsAt: "2026-09-19T15:00:00.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "744000000",
      },
      week: {
        startsAt: "2026-09-14T00:00:00.000Z",
        resetsAt: "2026-09-21T00:00:00.000Z",
        limitMicroCents: 3000000000,
        usedMicroCents: 960000000,
      },
      month: { limitMicroCents: "6000000000", usedMicroCents: "4344000000" },
    },
  },
};

test("parseOpencodeGoStatus maps the three console meters", () => {
  const meters = parseOpencodeGoStatus(FIXTURE);
  assert.deepEqual(meters.map((m) => m.label), ["5h rolling", "Weekly", "Monthly"]);

  const [fiveHour, week, month] = meters;
  // 744000000 / 1200000000 microcents = $7.44 of $12 = 62%.
  assert.equal(fiveHour.percent, 62);
  assert.equal(fiveHour.resetMs, Date.parse("2026-09-19T15:00:00.000Z"));
  assert.equal(fiveHour.seconds, 5 * 3_600);

  // Numeric microcent encodings count too (31.999…→ 32.0, one decimal).
  assert.equal(week.percent, 32);
  assert.equal(week.resetMs, Date.parse("2026-09-21T00:00:00.000Z"));

  // The month meter has no window: the paid period end is its reset.
  assert.equal(month.percent, 72.4);
  assert.equal(month.resetMs, Date.parse("2026-10-01T00:00:00.000Z"));
});

test("parseOpencodeGoStatus leaves the monthly reset undefined without a period end", () => {
  const meters = parseOpencodeGoStatus({
    access: { meters: { month: { limitMicroCents: "6000000000", usedMicroCents: "4344000000" } } },
  });
  assert.equal(meters.length, 1);
  assert.equal(meters[0]?.resetMs, undefined);
});

test("parseOpencodeGoStatus reports nothing for payloads without meters", () => {
  assert.deepEqual(parseOpencodeGoStatus(null), []);
  assert.deepEqual(parseOpencodeGoStatus({}), []);
  assert.deepEqual(parseOpencodeGoStatus({ access: {} }), []);
  // Signed out: the console answers 401 long before this, but a payload
  // without usable money fields must not become a confident zero either.
  assert.deepEqual(
    parseOpencodeGoStatus({ access: { meters: { fiveHour: { unlimited: true } } } }),
    [],
  );
});

test("parseOpencodeGoStatus clamps a zero limit to 0%", () => {
  const meters = parseOpencodeGoStatus({
    access: { meters: { fiveHour: { limitMicroCents: "0", usedMicroCents: "500" } } },
  });
  assert.equal(meters.length, 1);
  assert.equal(meters[0]?.percent, 0);
});

test("parseOpencodeGoUsage maps the key usage API windows", () => {
  const meters = parseOpencodeGoUsage({
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-25T00:43:18.063Z" },
      weekly: { status: "ok", percent: 55.04, resetsAt: "2026-09-28T00:00:00.000Z" },
      monthly: { status: "ok", percent: "84", resetsAt: "2026-10-08T22:06:17.000Z" },
    },
  });
  assert.deepEqual(meters.map((m) => m.label), ["5h rolling", "Weekly", "Monthly"]);

  const [rolling, weekly, monthly] = meters;
  assert.equal(rolling.percent, 0);
  assert.equal(rolling.resetMs, Date.parse("2026-09-25T00:43:18.063Z"));
  assert.equal(rolling.seconds, 5 * 3_600);
  assert.equal(rolling.usage, undefined);

  // One decimal, matching the console meter's percent precision.
  assert.equal(weekly.percent, 55);
  assert.equal(weekly.resetMs, Date.parse("2026-09-28T00:00:00.000Z"));

  // String percents count too.
  assert.equal(monthly.percent, 84);
  assert.equal(monthly.resetMs, Date.parse("2026-10-08T22:06:17.000Z"));
  assert.equal(monthly.seconds, 30 * 86_400);
});

test("parseOpencodeGoUsage skips windows without a percent and ignores a bad reset", () => {
  const meters = parseOpencodeGoUsage({
    usage: {
      rolling: { status: "ok", resetsAt: "2026-09-25T00:43:18.063Z" },
      weekly: { status: "ok", percent: 12, resetsAt: "not-a-date" },
    },
  });
  assert.equal(meters.length, 1);
  assert.equal(meters[0]?.label, "Weekly");
  assert.equal(meters[0]?.percent, 12);
  assert.equal(meters[0]?.resetMs, undefined);
});

test("parseOpencodeGoUsage reports nothing for payloads without usage windows", () => {
  assert.deepEqual(parseOpencodeGoUsage(null), []);
  assert.deepEqual(parseOpencodeGoUsage({}), []);
  assert.deepEqual(parseOpencodeGoUsage({ usage: {} }), []);
  assert.deepEqual(parseOpencodeGoUsage({ rollingUsage: { usagePercent: 1 } }), []);
});

test("opencodeGoCookieHeader pairs known names and prefixes bare values", () => {
  const consoleName = "__Host-console_session";
  // A bare session value (the env/fnox storage format) gets the console name.
  assert.equal(opencodeGoCookieHeader("rawsessionvalue"), `${consoleName}=rawsessionvalue`);
  // Known cookie names pass through, extra pairs and all.
  assert.equal(
    opencodeGoCookieHeader("auth=abc; other=def"),
    "auth=abc; other=def",
  );
  assert.equal(
    opencodeGoCookieHeader("__Host-console_session=abc"),
    "__Host-console_session=abc",
  );
  // A bare base64 value ending in `=` is not mistaken for a name=value pair.
  assert.equal(opencodeGoCookieHeader("Zm9vYmFy="), `${consoleName}=Zm9vYmFy=`);
  // An unknown name is treated as a bare value, and trailing `;` is trimmed.
  assert.equal(opencodeGoCookieHeader(" token ; "), `${consoleName}=token`);
});

const NOW = 1_700_000_000_000;

function row(id, cache, now = NOW) {
  return summarizeUsageCache(cache, now).find((entry) => entry.id === id);
}

test("summarizeUsageCache marks fresh, stale, and missing without treating a hole as zero", () => {
  const rows = summarizeUsageCache({
    "ollama-usage": {
      value: "$1 / $60 (2%)",
      commandText: "Included (pro): $1 of $60",
      fetchedAt: NOW - 30_000,
    },
    // Window chips share the 2-minute file TTL. 130s is stale; a scrape is not.
    "codex-window": { value: "1/5H: 10%", fetchedAt: NOW - 130_000 },
    "grok-window": { value: "2/7D: 4%", fetchedAt: "nope" },
  }, NOW);

  assert.equal(rows.length, 9);
  assert.equal(row("ollama-usage", {
    "ollama-usage": { value: "$1 / $60 (2%)", commandText: "Included (pro): $1 of $60", fetchedAt: NOW - 30_000 },
  }).status, "fresh");
  assert.equal(row("ollama-usage", {
    "ollama-usage": { value: "$1 / $60 (2%)", fetchedAt: NOW - 61_000 },
  }).status, "stale");
  assert.equal(row("codex-window", {
    "codex-window": { value: "1/5H: 10%", fetchedAt: NOW - 119_000 },
  }).status, "fresh");
  assert.equal(row("codex-window", {
    "codex-window": { value: "1/5H: 10%", fetchedAt: NOW - 130_000 },
  }).status, "stale");
  assert.equal(row("claude-bridge-window", {
    "claude-bridge-window": { value: "1/5H: 8%", fetchedAt: NOW - 179_000 },
  }).status, "fresh");
  assert.equal(row("claude-bridge-window", {
    "claude-bridge-window": { value: "1/5H: 8%", fetchedAt: NOW - 181_000 },
  }).status, "stale");
  assert.equal(row("grok-window", { "grok-window": { value: "2/7D: 4%", fetchedAt: "nope" } }).status, "missing");
  assert.equal(row("copilot-window", {}).status, "missing");
  assert.equal(row("copilot-window", {}).value, undefined);

  const ollama = rows.find((entry) => entry.id === "ollama-usage");
  assert.equal(ollama.status, "fresh");
  assert.equal(ollama.ageMs, 30_000);
  assert.equal(ollama.commandText, "Included (pro): $1 of $60");
});

test("summarizeUsageCache treats a future fetchedAt as stale with no age", () => {
  const ollama = row("ollama-usage", {
    "ollama-usage": { value: "$1 / $60", fetchedAt: NOW + 5_000 },
  });
  assert.equal(ollama.status, "stale");
  assert.equal(ollama.ageMs, undefined);
  assert.equal(ollama.value, "$1 / $60");
});

test("resolveUsageDriver accepts ids and the short names a model will pass", () => {
  assert.equal(resolveUsageDriver("openai")?.id, "codex-window");
  assert.equal(resolveUsageDriver("Codex")?.provider, "openai-codex");
  assert.equal(resolveUsageDriver("grok")?.id, "grok-window");
  assert.equal(resolveUsageDriver("xai")?.id, "grok-window");
  assert.equal(resolveUsageDriver("copilot")?.provider, "github-copilot");
  assert.equal(resolveUsageDriver("ollama-usage")?.provider, "ollama");
  assert.equal(resolveUsageDriver("claude")?.id, "claude-bridge-window");
  assert.equal(resolveUsageDriver(""), undefined);
  assert.equal(resolveUsageDriver("nope"), undefined);
});

test("formatUsageCacheReport is one block per driver and prefers commandText", () => {
  assert.equal(formatUsageCacheReport([
    { id: "grok-window", provider: "xai", status: "missing" },
    {
      id: "ollama-usage",
      provider: "ollama",
      status: "fresh",
      ageMs: 45_000,
      value: "$1 / $60 (2%)",
      commandText: "Included (pro): $1 of $60",
    },
  ]), "xai missing\nollama fresh 45s\nIncluded (pro): $1 of $60");
});
