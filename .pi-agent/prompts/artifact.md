---
description: Design a polished single-file HTML artifact and publish it to a shareable URL
argument-hint: "<what to build>"
---

Build a self-contained HTML artifact: **$@**

Then publish it and give me the link.

---

## Step 1 — Plan before you write

State in one or two lines: the **archetype** you're using, the **accent color**, and the
**typeface pairing**. Then write the file. Don't narrate further; just build it.

## Step 2 — Pick an archetype

| Archetype | Use when | Skeleton |
|---|---|---|
| `report` | Analysis, findings, writeups | Title block w/ eyebrow + date · lede paragraph · sectioned prose at `68ch` · pull-quotes · footnotes |
| `dashboard` | Metrics, status, monitoring | Sticky header · 3–4 KPI cards in a grid · one hero chart · dense table below |
| `landing` | Pitching an idea or product | Hero w/ one clear claim · 3-up feature grid · social proof strip · single CTA |
| `deck` | Sequential narrative | Full-viewport `<section>` slides · scroll-snap · arrow-key nav · slide counter |
| `explorer` | Data someone will poke at | Toolbar (search + filters) · sortable table or card grid · empty + loading states |
| `toy` | Interactive demo, simulation, game | Centered canvas/stage · minimal chrome · controls docked to one edge · reset button |

If none fit, say so and design from first principles — don't jam it into the wrong shape.

## Step 3 — Design system

**Tokens.** Define these once in `:root` and use them everywhere. Never hardcode a color
twice.

```css
:root {
  --bg: #fbfbfa;  --surface: #fff;    --border: #e6e4e0;
  --text: #1a1917; --muted: #6b6862;  --accent: /* pick one */;
  --radius: 10px;
  --shadow: 0 1px 2px rgb(0 0 0 / .04), 0 4px 12px rgb(0 0 0 / .05);
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0e0f11; --surface:#16181c; --border:#262a30;
          --text:#e8eaed; --muted:#9aa0a8; }
}
```

- **Never** `#000` on `#fff`. Use warm-neutral or cool-neutral ramps, pick one, commit.
- One accent, used sparingly — links, primary action, one chart series. Not decoration.
- Dark mode is required, via `prefers-color-scheme`. Check contrast in both.

**Typography.**
- Pair a UI face with an accent face. Good pairs: `Inter`/`Instrument Serif`,
  `Geist`/`Source Serif 4`, `IBM Plex Sans`/`IBM Plex Serif`. System stack is fine too —
  a well-set system stack beats a badly-set webfont.
- Type scale ~1.25. Body 16–17px. Line-height 1.6 for prose, 1.3 for headings.
- Prose measure capped at `68ch`. Tabular numerals (`font-variant-numeric: tabular-nums`)
  for anything in a column.
- Headings get `letter-spacing: -0.02em`. Small caps eyebrows get `+0.08em` and `--muted`.

**Space.** 4px grid. Be generous — the single most common failure is cramped padding.
Section rhythm ≥ 64px. Card padding ≥ 20px.

**Depth.** One shadow token, used at most on cards. Prefer 1px borders over shadows.
No gradients unless the archetype is `landing`.

## Step 4 — Non-negotiables

- [ ] Single file. No build step. Works opened from `file://`.
- [ ] Responsive and *checked* at 375 / 768 / 1440. No horizontal scroll at 375.
- [ ] `<title>`, `<meta name="description">`, and OG tags (`og:title`, `og:description`)
- [ ] Semantic HTML — real `<header> <main> <section> <table> <button>`, not div soup
- [ ] Visible `:focus-visible` ring. Keyboard-operable controls. WCAG AA contrast.
- [ ] `@media (prefers-reduced-motion: reduce) { *{animation:none!important;transition:none!important} }`
- [ ] A `@media print` block that drops chrome and goes to black-on-white
- [ ] Real content. No lorem ipsum. If data is invented, label it as sample data.
- [ ] Empty / loading / error states for anything interactive

## Step 5 — Dependencies

Prefer zero. Hand-written CSS with the tokens above will look better than default
Tailwind. If you genuinely need them, these are allowed via CDN:

- `cdn.tailwindcss.com` — only if the thing is component-dense
- `fonts.googleapis.com` / `fonts.gstatic.com` — webfonts
- `cdn.jsdelivr.net` — charts (prefer hand-rolled SVG for anything simple)

Never fetch user data, never `fetch()` an external API, never include analytics.

## Step 6 — Publish

Write the file to the current directory, then:

```bash
pub -o -d "<short title>" <file>.html
```

`pub` uploads it as a secret gist and prints a `gistpreview.github.io` URL, already
copied to the clipboard. Report the URL back to me as the last line of your response.

To revise after I give feedback: edit the file, then `pub -u <gist-id> <file>.html` —
the URL stays the same.

**Before publishing, confirm the artifact contains no secrets, tokens, internal
hostnames, PII, or VA/Oddball-internal information.** Secret gists are unlisted, not
private. If in doubt, ask me first and skip the publish step.
