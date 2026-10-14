// Prints each test as it starts, before the body runs. The spec reporter only
// names a test once it finishes, so a spawnSync that blocks the event loop
// never shows up — and --test-timeout cannot fire while the loop is blocked.
// writeSync so the line is in the CI log even if the process then wedges.
import { writeSync } from "node:fs";

export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== "test:start") continue;
    const data = event.data ?? {};
    const file = data.file ?? "?";
    const name = data.name ?? "?";
    writeSync(2, `START ${file} :: ${name}\n`);
  }
}
