---
description: Design a distinctive single-file HTML artifact and publish it to a shareable URL
argument-hint: "<what to build>"
---

Build a self-contained HTML artifact: **$@**

Then publish it and give me the link.

*(Design guidance below is adapted from Anthropic's `frontend-design` skill,
github.com/anthropics/skills, Apache 2.0.)*

---

Approach this as the design lead at a small studio known for giving every client a visual
identity that could not be mistaken for anyone else's. This client has already rejected
proposals that felt templated and is paying for a distinctive point of view. Make
deliberate, opinionated choices about palette, typography, and layout that are specific
to *this* brief, and take one real aesthetic risk you can justify.

## Ground it in the subject

If the brief doesn't pin down what the subject is, pin it yourself before designing: name
one concrete subject, its audience, and the page's single job, and state your choice. The
subject's own world — its materials, instruments, artifacts, and vernacular — is where
distinctive choices come from. Build with the brief's real content and subject matter
throughout.

## Do not converge on the defaults

AI-generated design right now clusters around three looks:

1. Warm cream background (near `#F4F1EA`), high-contrast serif display, terracotta accent
2. Near-black background with a single bright acid-green or vermilion accent
3. Broadsheet layout — hairline rules, zero border-radius, dense newspaper columns

All three are legitimate for *some* briefs, but they are defaults rather than choices, and
they show up regardless of subject. If the brief names a direction, follow it exactly.
Where it leaves an axis free, don't spend that freedom on one of these.

Also avoid: excessive centered layouts, purple gradients, uniform rounded corners
everywhere, and Inter as the default face.

## Design principles

**The hero is a thesis.** Open with the most characteristic thing in the subject's world,
in whatever form fits: a headline, an image, an animation, a live demo, an interactive
moment. A big number with a small label plus supporting stats and a gradient accent is
the template answer — use it only if it's genuinely best.

**Typography carries the personality.** Pair display and body faces deliberately, not the
families you'd reach for on any other project. Set a clear scale with intentional weights,
widths, and spacing. Make the type treatment itself memorable, not a neutral delivery
vehicle.

**Structure is information.** Numbering, eyebrows, dividers, labels should encode
something true about the content, not decorate it. `01 / 02 / 03` markers are only
appropriate if the content really is a sequence.

**Motion, deliberately.** One orchestrated moment usually lands harder than scattered
effects. Sometimes less is more — extra animation is a tell that a design is AI-generated.

**Match complexity to the vision.** Maximalist directions need elaborate execution;
minimal directions need precision in spacing, type, and detail.

## Process: plan → critique → build → critique

Work in two passes, mostly in your thinking. Only show me things you're confident about.

**Pass 1 — the plan.** A compact token system for this brief:
- **Color** — 4–6 named hex values
- **Type** — faces for 2+ roles: a characterful display face used with restraint, a
  complementary body face, a utility face for captions or data if needed
- **Layout** — a one-sentence concept plus an ASCII wireframe; compare two or three
- **Signature** — the single element this page will be remembered by

**Pass 2 — critique the plan before writing code.** Work through a similar generic prompt
in your head. If you'd have arrived at the same place, that part is a default, not a
choice. Revise it and say what you changed and why. Only then write the code, deriving
every color and type decision from the revised plan.

Watch CSS specificity while building — type selectors like `.section` and element
selectors like `.cta` cancel each other out easily, especially on section padding.

## Restraint

Spend your boldness in one place. Let the signature element be the memorable thing and
keep everything around it quiet and disciplined. Not taking a risk is itself a risk. Then
take Chanel's advice: before leaving the house, look in the mirror and remove one
accessory.

**Quality floor — meet it without announcing it:** responsive to mobile, visible keyboard
focus, reduced motion respected, WCAG AA contrast, semantic HTML, real empty/error states.
Take screenshots and critique your own work — a picture is worth 1000 tokens.

## Copy

Words are design material, not decoration. Write from the user's side of the screen: name
things by what people control, not how the system is built. Active voice; a control says
exactly what happens ("Save changes," not "Submit"), and keeps that name through the whole
flow. Errors explain what went wrong and how to fix it — they don't apologize and are
never vague. An empty screen is an invitation to act. Specific beats clever. No lorem
ipsum; if data is invented, label it as sample data.

## Constraints

Single file, no build step, works from `file://`. Include `<title>`, a description meta,
and OG tags. Prefer zero dependencies — hand-written CSS beats default Tailwind. If needed:
`cdn.tailwindcss.com`, `fonts.googleapis.com`/`gstatic.com`, `cdn.jsdelivr.net` for charts.
Never `fetch()` an external API, never include analytics.

## Publish

Write the file to the current directory, then:

```bash
pub -o -d "<short title>" <file>.html
```

`pub` uploads it as a secret gist and prints a `gistpreview.github.io` URL, already copied
to the clipboard. Report the URL as the last line of your response. To revise: edit, then
`pub -u <gist-id> <file>.html` — the URL stays the same.

**Before publishing, confirm the artifact contains no secrets, tokens, internal hostnames,
PII, or VA/Oddball-internal information.** Secret gists are unlisted, not private. If in
doubt, ask me first and skip the publish step.
