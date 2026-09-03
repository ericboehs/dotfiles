import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Force opencode Zen/Go requests to look like the official opencode CLI.
 *
 * Background: pi 0.84.4 sends `x-opencode-client: pi`, which Zen routes to
 * the restrictive `dailyRequestsFallback` pool (FreeUsageLimitError / 429).
 * The official CLI sends `x-opencode-client: cli` + opencode User-Agent and
 * gets the generous `dailyRequests` pool.
 *
 * This extension overrides both, preserving pi's session id for caching.
 * Covers `opencode`, `opencode-go`, and any custom provider pointed at
 * opencode.ai.
 *
 * Note: OpenCode caps the free pool to the canonical client on purpose
 * (see anomalyco/opencode#28807). This may stop working if they tighten
 * the check. If it does, switch the model to Go / paid Zen.
 */

const CLI_HEADERS: Record<string, string> = {
  "x-opencode-client": "cli",
  "User-Agent": "opencode/latest/1.3.15/cli",
};

export default function opencodeZenHeaders(pi: ExtensionAPI) {
  // Scoped override: wins over pi's built-in `x-opencode-client: pi`
  // because provider headers are merged last in prepareRequest.
  pi.registerProvider("opencode", { headers: { ...CLI_HEADERS } });
  pi.registerProvider("opencode-go", { headers: { ...CLI_HEADERS } });

  // Belt-and-suspenders: final mutate after attribution merge.
  // Runs once per provider request; retries reuse headers.
  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    const provider = model?.provider ?? "";
    const baseUrl = model?.baseUrl ?? "";
    const isOpenCode =
      provider === "opencode" ||
      provider === "opencode-go" ||
      baseUrl.includes("opencode.ai");
    if (!isOpenCode) return;

    event.headers["x-opencode-client"] = "cli";
    event.headers["User-Agent"] = "opencode/latest/1.3.15/cli";
    // Do NOT touch x-opencode-session: pi already sets it to the session
    // id, which Zen uses for prompt-cache optimization.
  });
}
