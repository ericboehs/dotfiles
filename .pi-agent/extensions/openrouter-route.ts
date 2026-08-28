/**
 * Which upstream provider OpenRouter actually routed a turn to, for the footer
 * chip: `or novita/oxa` instead of a bare `or oxa`.
 *
 * OpenRouter reports the decision in `openrouter_metadata`, an opt-in field
 * enabled per request with `X-OpenRouter-Metadata: enabled`. It rides in the
 * response *body* (last SSE chunk before `[DONE]`), and pi hands extensions
 * only status + headers via `after_provider_response` — so the body has to be
 * read in passing.
 *
 * pi-ai builds its OpenAI client per request and resolves `fetch` through the
 * SDK's `getDefaultFetch()`, which reads the current global. Wrapping
 * `globalThis.fetch` therefore catches every OpenRouter completion without an
 * extra round trip: the header goes out, the response streams through a
 * pass-through transform that watches for the metadata line, and the selected
 * provider lands in a globalThis stash the footer reads (color.ts's contract
 * pattern — importing across extensions would make a missing file fatal).
 *
 * The alternative costs a request per turn: `responseId` is OpenRouter's
 * generation id, and `GET /api/v1/generation?id=` reports `provider_name`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Read by footer.ts. */
export const ROUTE_STASH_KEY = "__piOpenRouterRoute";
/** Emitted after a stash write so the footer repaints without a keystroke. */
export const ROUTE_UPDATE_EVENT = "openrouter-route:updated";
/** Marks the global patch so a reload (or a second profile) cannot stack wrappers. */
const PATCH_FLAG = "__piOpenRouterRoutePatched";

const METADATA_HEADER = "x-openrouter-metadata";
/** Give up on a response that never carries metadata rather than buffer it all. */
const MAX_SNIFF_CHARS = 1_000_000;

/** What the footer reads out of the stash. */
export interface OpenRouterRoute {
  /** Provider name as OpenRouter reports it, e.g. "Novita", "Z.AI", "BaseTen". */
  provider: string;
  /** Model the response was for, so a stale route is not painted onto a new model. */
  model?: string;
  at: number;
}

/** Completion routes; the key/credits endpoints provider-usage.ts calls are not routed. */
const COMPLETION_PATHS = /\/(chat\/completions|completions|responses|messages)$/;

export function isOpenRouterCompletion(input: RequestInfo | URL): boolean {
  const href =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url;
  try {
    const url = new URL(href);
    return (
      (url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai")) &&
      COMPLETION_PATHS.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Pull the selected provider out of a parsed chunk.
 *
 * `endpoints.available[].selected` is the authoritative field; `attempts` and
 * the human-readable `summary` are fallbacks for shapes where the router
 * retried or reported the decision without an endpoint snapshot.
 */
export function extractRoute(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const meta = (payload as { openrouter_metadata?: unknown }).openrouter_metadata;
  if (!meta || typeof meta !== "object") return undefined;

  const { endpoints, attempts, summary } = meta as {
    endpoints?: { available?: Array<{ provider?: unknown; selected?: unknown }> };
    attempts?: Array<{ provider?: unknown }>;
    summary?: unknown;
  };

  const selected = endpoints?.available?.find((entry) => entry?.selected === true)?.provider;
  if (typeof selected === "string" && selected) return selected;

  if (Array.isArray(attempts)) {
    // The attempt that succeeded is the last one recorded.
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const provider = attempts[i]?.provider;
      if (typeof provider === "string" && provider) return provider;
    }
  }

  if (typeof summary === "string") {
    const match = /selected=([^,]+)/.exec(summary);
    const name = match?.[1]?.trim();
    if (name) return name;
  }

  return undefined;
}

function modelOf(payload: unknown): string | undefined {
  const model = (payload as { model?: unknown } | null)?.model;
  return typeof model === "string" && model ? model : undefined;
}

/**
 * Line-oriented scanner over a completion body.
 *
 * Handles both shapes with one path: SSE (`data: {...}` per line) and a plain
 * JSON body, which `flush` parses as the final line. Only lines that mention
 * the field are parsed, so the common chunk stream costs a substring search.
 */
export function createRouteSniffer(
  onRoute: (provider: string, model: string | undefined) => void,
): { push(chunk: Uint8Array): void; flush(): void } {
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  function consider(line: string): void {
    if (!line.includes("openrouter_metadata")) return;
    const json = line.startsWith("data:") ? line.slice("data:".length).trim() : line.trim();
    if (!json || json === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }
    const provider = extractRoute(payload);
    if (!provider) return;
    finished = true;
    onRoute(provider, modelOf(payload));
  }

  function scan(): void {
    let newline = buffer.indexOf("\n");
    while (newline !== -1 && !finished) {
      consider(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    // A body that never carries metadata must not grow without bound.
    if (!finished && buffer.length > MAX_SNIFF_CHARS) finished = true;
    if (finished) buffer = "";
  }

  return {
    push(chunk) {
      if (finished) return;
      buffer += decoder.decode(chunk, { stream: true });
      scan();
    },
    flush() {
      if (finished) return;
      buffer += decoder.decode();
      scan();
      if (!finished && buffer) consider(buffer);
      buffer = "";
      finished = true;
    },
  };
}

/**
 * Wrap a fetch so OpenRouter completions opt into metadata and stream through
 * a sniffer. Every other request is passed straight to the original.
 */
export function wrapFetch(
  original: typeof fetch,
  onRoute: (provider: string, model: string | undefined) => void,
): typeof fetch {
  return async function piOpenRouterRouteFetch(input, init) {
    if (!isOpenRouterCompletion(input)) return original(input, init);

    const headers = new Headers(
      init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
    );
    headers.set(METADATA_HEADER, "enabled");

    const response = await original(input, { ...init, headers });
    // Errors and empty bodies are handed back untouched: no metadata to read,
    // and re-wrapping would only risk breaking pi's error path.
    if (!response.ok || !response.body) return response;

    const sniffer = createRouteSniffer(onRoute);
    const sniffed = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          // Forward first: sniffing must never delay or drop a token.
          controller.enqueue(chunk);
          try {
            sniffer.push(chunk);
          } catch {
            /* a malformed body is not worth failing the turn over */
          }
        },
        flush() {
          try {
            sniffer.flush();
          } catch {
            /* ignore */
          }
        },
      }),
    );

    const wrapped = new Response(sniffed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // `new Response` drops url/redirected; the SDK reports url on errors.
    Object.defineProperty(wrapped, "url", { value: response.url });
    return wrapped;
  };
}

export default function openrouterRoute(pi: ExtensionAPI): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[PATCH_FLAG]) return;
  scope[PATCH_FLAG] = true;

  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = wrapFetch(original, (provider, model) => {
    scope[ROUTE_STASH_KEY] = { provider, model, at: Date.now() } satisfies OpenRouterRoute;
    pi.events.emit(ROUTE_UPDATE_EVENT, undefined);
  });
}
