/**
 * On-demand loader + switcher for pi-claude-bridge (Claude Code provider).
 *
 * The bridge's 105KB entry imports the Claude Agent SDK at module load, ~125ms
 * on every boot: two-thirds of all extension time. It is deliberately absent
 * from `packages` in settings.e14.json so pi never loads it at startup.
 *
 * /bridge imports it once per session through a Proxy that captures the exact
 * Model objects the bridge hands to pi.registerProvider, then pi.setModel()s
 * one of them. Capturing (rather than reading ctx.scopedModels) is the whole
 * trick: the scope snapshot is taken at session start, when the provider does
 * not exist yet, so no enabledModels pin can ever resolve it. No pin needed.
 *
 * A `__piClaudeBridgeWanted` globalThis flag re-registers the provider when
 * extension factories re-run after /reload (same process), so the bridge
 * survives reloads; fresh processes still boot fast. To revert, restore
 * `npm:pi-claude-bridge` to packages and delete this file.
 */
import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Must match PROVIDER_ID in pi-claude-bridge/src/convert.ts (inlined: importing it would load pi-ai at boot). */
const PROVIDER_ID = "claude-bridge";
/** Must match the registerProvider definition in pi-claude-bridge/src/index.ts. */
const BRIDGE_API = "claude-bridge";
const BRIDGE_BASE_URL = "claude-bridge";

type BridgeModel = Parameters<ExtensionAPI["setModel"]>[0];

interface BridgeStash {
  __piClaudeBridgeWanted?: boolean;
  __piClaudeBridgeModels?: BridgeModel[];
}

function bridgeEntry(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "npm", "node_modules", "pi-claude-bridge", "src", "index.ts");
}

/**
 * Import the bridge and hand it a pi object that captures the Model objects it
 * registers, returning them. In-flight loads are shared so a factory re-run
 * racing a /bridge invocation cannot double-register.
 */
let loading: Promise<BridgeModel[] | undefined> | undefined;

function withCatalogueFields(
  models: BridgeModel[],
  overrides: Record<string, Record<string, unknown>>,
): BridgeModel[] {
  // Mirror what pi's applyExtension attaches during recompose ({...definition,
  // api, provider, baseUrl, headers: undefined}): the definitions handed to
  // registerProvider carry none of these, and streaming, auth gates, and the
  // bridge's own baseUrl checks all read them off the active model.
  // Model-level overrides from models.json (e.g. the deliberate 256k caps)
  // are applied the same way applyModelOverride would.
  return models.map(
    (model) =>
      ({
        ...(model as Record<string, unknown>),
        ...overrides[(model as { id?: string }).id ?? ""],
        api: BRIDGE_API,
        provider: PROVIDER_ID,
        baseUrl: BRIDGE_BASE_URL,
        headers: undefined,
      }) as BridgeModel,
  );
}

/** providers["claude-bridge"].modelOverrides from the live models.json, if any. */
async function bridgeOverrides(): Promise<Record<string, Record<string, unknown>>> {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const parsed: unknown = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
    const providers = (parsed as { providers?: unknown } | null)?.providers as
      | Record<string, { modelOverrides?: Record<string, Record<string, unknown>> }>
      | undefined;
    return providers?.[PROVIDER_ID]?.modelOverrides ?? {};
  } catch {
    return {};
  }
}

async function loadBridge(pi: ExtensionAPI): Promise<BridgeModel[] | undefined> {
  loading ??= (async (): Promise<BridgeModel[] | undefined> => {
    const entry = bridgeEntry();
    try {
      await access(entry, constants.R_OK);
    } catch {
      return undefined;
    }
    try {
      const mod = (await import(entry)) as { default?: unknown };
      if (typeof mod.default !== "function") return undefined;
      let captured: BridgeModel[] | undefined;
      const capturingPi = new Proxy(pi, {
        get(target, prop) {
          // Target (not the proxy) as receiver: private-field-safe.
          const value: unknown = Reflect.get(target, prop);
          if (prop === "registerProvider") {
            return (id: unknown, def: unknown) => {
              const models = (def as { models?: unknown } | undefined)?.models;
              if (id === PROVIDER_ID && Array.isArray(models)) {
                captured = models as BridgeModel[];
              }
              return (value as (id: unknown, def: unknown) => unknown)(id, def);
            };
          }
          return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
        },
      });
      await (mod.default as (api: ExtensionAPI) => void | Promise<void>)(capturingPi);
      if (!captured?.length) return undefined;
      return withCatalogueFields(captured, await bridgeOverrides());
    } catch (err) {
      console.error(`[claude-bridge-lazy] load failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      // Reset so a failed load can be retried; a success is memoized below.
      if (!((globalThis as BridgeStash).__piClaudeBridgeModels ?? []).length) loading = undefined;
    }
  })();
  return loading;
}

function pickModel(models: readonly BridgeModel[], fragment: string): BridgeModel | undefined {
  if (fragment) {
    return models.find((model) =>
      String((model as { id?: unknown }).id ?? "").toLowerCase().includes(fragment),
    );
  }
  return (
    models.find((model) => (model as { id?: unknown }).id === "claude-opus-5") ?? models[0]
  );
}

export default function claudeBridgeLazy(pi: ExtensionAPI): void {
  const stash = globalThis as BridgeStash;
  // Post-/reload re-registration: factories re-run in-process, so a wanted
  // bridge comes back on its own and Ctrl+P sees it. Fresh boots skip this.
  if (stash.__piClaudeBridgeWanted && !stash.__piClaudeBridgeModels?.length) {
    void loadBridge(pi).then((models) => {
      if (models?.length) stash.__piClaudeBridgeModels = models;
    });
  }
  pi.registerCommand("bridge", {
    description: "Load the Claude bridge on demand and switch to it (/bridge [model-fragment])",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
      };
      stash.__piClaudeBridgeWanted = true;
      let models = stash.__piClaudeBridgeModels;
      if (!models?.length) {
        models = (await loadBridge(pi)) ?? undefined;
        if (models?.length) stash.__piClaudeBridgeModels = models;
      }
      if (!models?.length) {
        stash.__piClaudeBridgeWanted = false;
        notify(`Bridge not on disk at ${bridgeEntry()}; reinstall with: pi install npm:pi-claude-bridge`, "error");
        return;
      }
      // Registration updates pi's auth snapshot synchronously when the
      // provider counts as configured; otherwise refresh the snapshot (runs
      // the provider's own checkAuth) so setModel's gate sees it. Either
      // way this is best-effort and never blocks the switch attempt.
      try {
        await ctx.modelRegistry.refresh();
      } catch {
        // Offline or provider check failed; setModel reports the outcome.
      }
      const fragment = args.trim().toLowerCase();
      const target = pickModel(models, fragment);
      if (!target) {
        const ids = models.map((model) => String((model as { id?: unknown }).id ?? "?")).join(", ");
        notify(`No claude-bridge model matches "${args.trim()}". Available: ${ids || "none"}`, "warning");
        return;
      }
      let switched: boolean;
      try {
        switched = await pi.setModel(target);
      } catch {
        switched = false;
      }
      const id = String((target as { id?: unknown }).id ?? "unknown");
      notify(
        switched
          ? `Switched to ${id} via the Claude bridge.`
          : `Claude bridge loaded but ${id} refused (no auth for its provider?)`,
        switched ? "info" : "warning",
      );
    },
  });
}
