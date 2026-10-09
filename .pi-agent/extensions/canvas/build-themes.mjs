#!/usr/bin/env node
// Rebuilds themes.json from Omarchy's first-party themes (MIT, basecamp/omarchy).
// Each theme is one colors.toml of flat `key = "#hex"` lines; we keep them raw
// and let theme.mjs derive the page's variables, so a refresh is just a rerun.
//   node build-themes.mjs            # tip of the default branch
//   node build-themes.mjs <sha>      # a pinned commit
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseColors } from "./theme.mjs";

export { parseColors };

const REPO = "basecamp/omarchy";

function build(refArg) {
  const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 1 << 24 }));
  const ref = refArg || gh(`repos/${REPO}/commits/${gh(`repos/${REPO}`).default_branch}`).sha;
  const themes = {};
  for (const d of gh(`repos/${REPO}/contents/themes?ref=${ref}`).filter((e) => e.type === "dir")) {
    let file;
    try {
      file = gh(`repos/${REPO}/contents/themes/${d.name}/colors.toml?ref=${ref}`);
    } catch {
      console.error(`skip ${d.name}: no colors.toml`);
      continue;
    }
    const c = parseColors(Buffer.from(file.content, "base64").toString("utf8"));
    if (!/^#[0-9a-f]{6}$/i.test(c.background || "") || !/^#[0-9a-f]{6}$/i.test(c.foreground || "")) {
      console.error(`skip ${d.name}: missing background/foreground`);
      continue;
    }
    themes[d.name] = c;
  }
  const out = { source: `https://github.com/${REPO}/tree/${ref}/themes`, license: "MIT, © Basecamp / Omarchy contributors", themes };
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "themes.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`${Object.keys(themes).length} themes from ${ref.slice(0, 7)}`);
}

// Only when run, not when the tests import parseColors.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build(process.argv[2]);
