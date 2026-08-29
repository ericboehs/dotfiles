---
description: Design a distinctive single-file HTML artifact and publish it to a shareable URL
argument-hint: "<what to build>"
---

Build a self-contained HTML artifact: **$@**

Then publish it and give me the link.

## Step 1 — Load the design brief

Read `~/.pi/agent/artifact-skills/frontend-design/SKILL.md` now and follow it as your
design methodology. It is the authoritative guidance for this task — do not substitute
your own design instincts for it, and do not skip its plan-then-critique process.

Read these only if they apply:

| File (under `~/.pi/agent/artifact-skills/`) | Read it when |
|---|---|
| `web-artifacts-builder/SKILL.md` | The artifact needs React, routing, real state, or shadcn/ui. Not for single-file HTML/JSX. |
| `algorithmic-art/SKILL.md` | Generative or computational visuals — p5.js, flow fields, particle systems. |
| `canvas-design/SKILL.md` | The deliverable is a static poster or PDF rather than a web page. |
| `brand-guidelines/SKILL.md` | I ask for something in Anthropic's brand. |

These are vendored verbatim from `anthropics/skills` (Apache 2.0), pinned in
`MANIFEST`. Refresh with `artifact-skills-sync --update`.

## Step 2 — Constraints for this pipeline

Everything in `frontend-design` applies. On top of it:

- **Single file, no build step**, works opened from `file://`. If you used
  `web-artifacts-builder`, bundle down to one HTML file before publishing.
- `<title>`, a description meta, and OG tags (`og:title`, `og:description`).
- Prefer zero dependencies. If needed: `cdn.tailwindcss.com`,
  `fonts.googleapis.com`/`gstatic.com`, `cdn.jsdelivr.net` for charts.
- Never `fetch()` an external API. No analytics.
- No lorem ipsum. If the data is invented, label it as sample data in the artifact.

## Step 3 — Render it and look at it

Do not publish a page you have not seen. Reading the source is not sufficient: this
step routinely catches defects that produce a valid, error-free, *wrong-looking*
page — a `font:` shorthand on a parent silently overriding a child rule, a CSS
`fill` beating an SVG `fill` attribute, labels clipped outside a viewBox, text
colliding where two shapes cross.

Playwright cannot load `file://` on macOS, so serve the directory first:

```bash
python3 -m http.server 8899 &
playwright-cli -s=art open http://localhost:8899/<file>.html
playwright-cli -s=art screenshot --filename=shot.png
```

Then **read the PNG** and write out an explicit list of what is wrong with it before
changing anything. Work through:

- 375 / 768 / 1440 — check `document.documentElement.scrollWidth > innerWidth`
- both colour schemes:
  `run-code "async page => await page.emulateMedia({colorScheme:'dark'})"`
- every interactive state, including the empty one
- the console is clean
- nothing clipped, colliding, or overflowing its container
- computed styles match intent where CSS could be fighting itself:
  `--raw eval "getComputedStyle(document.querySelector('.x')).fontFamily"`

Fix each defect and re-shoot until the list is empty. Then stop the server and delete
the PNGs and `.playwright-cli/` — they must not end up in the published file's directory
or a git commit.

## Step 4 — Publish

Write the file to the current directory, then:

```bash
pub -o -d "<short title>" <file>.html
```

`pub` uploads it as a secret gist and prints a `gistpreview.github.io` URL, already copied
to the clipboard. Report the URL as the last line of your response. To revise: edit the
file, then `pub -u <gist-id> <file>.html` — the URL stays the same.

**Before publishing, confirm the artifact contains no secrets, tokens, internal hostnames,
PII, or VA/Oddball-internal information.** Secret gists are unlisted, not private. If in
doubt, ask me first and skip the publish step.
