/**
 * Tests for the OpenCode Go console-API parser in provider-usage.ts.
 *
 * The old workspace-page scrape broke when OpenCode moved usage behind
 * GET /console/api/go/status (x-org-id: wrk_…), so the parser's contract
 * with that JSON shape is pinned here: string-encoded microcents, month
 * without its own reset, and the paid-period end as the monthly fallback.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  opencodeGoCookieHeader,
  parseOpencodeGoStatus,
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
