import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Optional local checkout, not a copied bridge. Lifecycle connection policy lives there.
// A missing checkout must not break pi on other machines.
export default async function webChat(pi: ExtensionAPI, home = homedir()): Promise<void> {
  const entry = join(home, "Code/github.com/ericboehs/psst-web/bridge/extension.mjs");
  let factory: ExtensionFactory;
  try {
    const bridge = await import(pathToFileURL(entry).href);
    if (typeof bridge.default !== "function") throw new Error("Unsupported bridge");
    factory = bridge.default;
  } catch {
    pi.registerCommand("web-chat", {
      description: "Local psst-web bridge unavailable on this machine",
      handler: async (_args, ctx) => {
        ctx.ui.notify("Web chat needs a working ~/Code/github.com/ericboehs/psst-web/bridge checkout. Restore it, then restart pi. Nothing was connected.", "warning");
      },
    });
    return;
  }
  await factory(pi);
}
