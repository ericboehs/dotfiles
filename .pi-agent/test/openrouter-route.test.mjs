/**
 * Tests for the OpenRouter route sniffer.
 *
 * Drives the real wrapper against a stub fetch, so it proves both the parsing
 * and that a wrapped response still streams every byte through untouched.
 *
 *   bin/pi-ext-check
 *   node --test .pi-agent/test
 */

import assert from "node:assert/strict";
import test from "node:test";

import openrouterRoute, {
  createRouteSniffer,
  extractRoute,
  isOpenRouterCompletion,
  wrapFetch,
} from "../extensions/openrouter-route.ts";

const COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions";

const METADATA = {
  attempt: 1,
  strategy: "direct",
  endpoints: {
    available: [
      { model: "z-ai/glm-5.3-flash", provider: "Baseten", selected: false },
      { model: "z-ai/glm-5.3-flash", provider: "Novita", selected: true },
    ],
    total: 2,
  },
  summary: "available=2, selected=Novita",
};

function sseBody(...lines) {
  return new ReadableStream({
    start(controller) {
      const encode = new TextEncoder();
      for (const line of lines) controller.enqueue(encode.encode(line));
      controller.close();
    },
  });
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** Run the wrapper against a canned response and report what it saw. */
async function routeOf(body, { status = 200, url = COMPLETIONS } = {}) {
  const routes = [];
  const requests = [];
  const fetchImpl = wrapFetch(async (input, init) => {
    requests.push({ input, init });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }, (provider, model) => routes.push({ provider, model }));

  const response = await fetchImpl(url, { method: "POST" });
  const text = await drain(response.body);
  return { routes, requests, text, response };
}

test("only OpenRouter completion routes are sniffed", () => {
  assert.equal(isOpenRouterCompletion(COMPLETIONS), true);
  assert.equal(isOpenRouterCompletion("https://openrouter.ai/api/v1/messages"), true);
  assert.equal(isOpenRouterCompletion(new URL(COMPLETIONS)), true);
  // provider-usage.ts polls these; they are not routed and carry no metadata.
  assert.equal(isOpenRouterCompletion("https://openrouter.ai/api/v1/key"), false);
  assert.equal(isOpenRouterCompletion("https://api.baseten.co/v1/chat/completions"), false);
  assert.equal(isOpenRouterCompletion("not a url"), false);
});

test("the selected endpoint wins over attempts and the summary", () => {
  assert.equal(extractRoute({ openrouter_metadata: METADATA }), "Novita");
  assert.equal(
    extractRoute({
      openrouter_metadata: {
        attempts: [{ provider: "Morph", status: 503 }, { provider: "Modal", status: 200 }],
      },
    }),
    "Modal",
  );
  assert.equal(
    extractRoute({ openrouter_metadata: { summary: "available=3, selected=Z.AI" } }),
    "Z.AI",
  );
});

test("payloads without metadata report nothing", () => {
  assert.equal(extractRoute(undefined), undefined);
  assert.equal(extractRoute({ choices: [] }), undefined);
  assert.equal(extractRoute({ openrouter_metadata: {} }), undefined);
  assert.equal(extractRoute({ openrouter_metadata: { endpoints: { available: [] } } }), undefined);
});

test("the provider is read off the final SSE chunk, and the stream is untouched", async () => {
  const chunks = [
    'data: {"id":"gen-1","model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"hi"}}]}\n\n',
    `data: ${JSON.stringify({ id: "gen-1", model: "z-ai/glm-5.3-flash", openrouter_metadata: METADATA })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const { routes, text, requests } = await routeOf(sseBody(...chunks));

  assert.deepEqual(routes, [{ provider: "Novita", model: "z-ai/glm-5.3-flash" }]);
  assert.equal(text, chunks.join(""), "every byte reaches the SDK unchanged");
  assert.equal(new Headers(requests[0].init.headers).get("x-openrouter-metadata"), "enabled");
});

test("a metadata line split across chunk boundaries is still read", async () => {
  const line = `data: ${JSON.stringify({ model: "z-ai/glm-5.3-flash", openrouter_metadata: METADATA })}\n`;
  const { routes } = await routeOf(sseBody(line.slice(0, 30), line.slice(30, 90), line.slice(90)));
  assert.deepEqual(routes, [{ provider: "Novita", model: "z-ai/glm-5.3-flash" }]);
});

test("a non-streaming JSON body is read on flush", async () => {
  const body = JSON.stringify({ model: "z-ai/glm-5.3-flash", openrouter_metadata: METADATA });
  const { routes } = await routeOf(sseBody(body));
  assert.deepEqual(routes, [{ provider: "Novita", model: "z-ai/glm-5.3-flash" }]);
});

test("cache hits and error responses report no route and are passed through", async () => {
  const cached = 'data: {"id":"gen-2","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const hit = await routeOf(sseBody(cached));
  assert.deepEqual(hit.routes, []);
  assert.equal(hit.text, cached);

  const failed = await routeOf(sseBody('{"error":{"message":"nope"}}'), { status: 429 });
  assert.deepEqual(failed.routes, []);
  assert.equal(failed.response.status, 429);
});

test("non-OpenRouter requests are handed straight to the original fetch", async () => {
  const seen = [];
  const sentinel = new Response("ok");
  const fetchImpl = wrapFetch(async (input, init) => {
    seen.push([input, init]);
    return sentinel;
  }, () => assert.fail("must not sniff"));

  const response = await fetchImpl("https://example.com/thing", { method: "GET" });
  assert.equal(response, sentinel, "the response object is not rewrapped");
  assert.deepEqual(seen, [["https://example.com/thing", { method: "GET" }]]);
});

test("a truncated JSON metadata line is ignored instead of throwing", () => {
  const sniffer = createRouteSniffer(() => assert.fail("must not report"));
  sniffer.push(new TextEncoder().encode('data: {"openrouter_metadata":{"endpo\n'));
  sniffer.flush();
});

test("the global patch is installed once, no matter how often the extension loads", () => {
  const original = globalThis.fetch;
  const scope = globalThis;
  const hadFlag = "__piOpenRouterRoutePatched" in scope;
  const previousFlag = scope.__piOpenRouterRoutePatched;
  delete scope.__piOpenRouterRoutePatched;
  const events = [];
  const pi = { events: { emit: (name) => events.push(name) } };

  try {
    openrouterRoute(pi);
    const patched = globalThis.fetch;
    assert.notEqual(patched, original, "the first load wraps fetch");
    openrouterRoute(pi);
    assert.equal(globalThis.fetch, patched, "a reload does not stack wrappers");
  } finally {
    globalThis.fetch = original;
    if (hadFlag) scope.__piOpenRouterRoutePatched = previousFlag;
    else delete scope.__piOpenRouterRoutePatched;
  }
});
