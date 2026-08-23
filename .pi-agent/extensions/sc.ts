// /sc [instructions] — pull the newest screenshot out of iCloud Drive's
// Downloads folder and attach it to the conversation.
//
// The use case is being away from the Mac: share a screenshot on the iPad to
// Files -> iCloud Drive -> Downloads, SSH home with Blink, run /sc in pi, and
// the image lands in the session as if it had been pasted in locally. Any
// arguments become the instruction for what to do with it ("what does this
// error say"), defaulting to just reading it.
//
// Non-image files work too — they're sent by path so the agent can read them
// like any other file. iCloud eviction placeholders (.icloud) are reported
// rather than silently skipped, since the fix (open the file once on a signed
// in device) is different from "nothing synced yet".

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DOWNLOADS = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "Downloads",
);

// pi's ImageContent is flat — { type, data, mimeType }. Not Anthropic's nested
// { source: { type: "base64", media_type, data } }, which is what the wire
// format looks like and what docs/extensions.md shows; passing that shape sends
// no mime type at all and every provider rejects the request.
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function newestFile(): Promise<{
  name: string;
  path: string;
  mtime: Date;
} | null> {
  let names: string[];
  try {
    names = await readdir(DOWNLOADS);
  } catch {
    return null;
  }

  // Skip directories and macOS cruft. Sort explicitly by mtime — readdir order
  // is unspecified and the folder holds hundreds of old receipts.
  let newest: { name: string; path: string; mtime: Date } | null = null;
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(DOWNLOADS, name);
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) continue;
    if (!newest || stats.mtime > newest.mtime) {
      newest = { name, path, mtime: stats.mtime };
    }
  }
  return newest;
}

function age(mtime: Date): string {
  const seconds = Math.round((Date.now() - mtime.getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sc", {
    description:
      "Attach the newest file from iCloud Downloads (iPad screenshot handoff)",
    handler: async (args, ctx) => {
      const found = await newestFile();
      if (!found) {
        ctx.ui.notify(
          `Nothing found in ${DOWNLOADS} — check iCloud sync`,
          "error",
        );
        return;
      }

      if (found.name.endsWith(".icloud")) {
        ctx.ui.notify(
          `${found.name.slice(0, -7)} hasn't downloaded yet — open it once on a signed-in device`,
          "error",
        );
        return;
      }

      const when = age(found.mtime);
      const instruction = args?.trim() || "Read this screenshot.";
      const mimeType = IMAGE_TYPES[found.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ""];
      // The path is included even though the image is attached inline: it makes
      // the file reachable to tools (re-read a region at full resolution, sips,
      // copy it somewhere) instead of being a one-shot bitmap. Saying it is
      // attached keeps the agent from spending a re-read to look at what it can
      // already see.
      const label = `Latest in iCloud Downloads: "${found.path}" (${when}), attached`;

      if (!mimeType) {
        // Not an image — nothing is attached, so the path is the whole payload.
        await pi.sendUserMessage(
          `Latest in iCloud Downloads: "${found.path}" (${when}). It's not an image; read the file. ${instruction}`,
        );
        return;
      }

      const data = (await readFile(found.path)).toString("base64");
      await pi.sendUserMessage([
        { type: "text", text: `${label}. ${instruction}` },
        { type: "image", data, mimeType },
      ]);
    },
  });
}
