# Claude Code settings

`settings.example.json` is a starting point for `~/.claude/settings.json`. Copy it
verbatim and delete what you don't want:

```sh
cp .claude/settings.example.json ~/.claude/settings.json
```

Full reference: <https://code.claude.com/docs/en/settings>

## Before you edit it

**`settings.json` is strict JSON.** It is parsed with `JSON.parse` after a BOM
strip — no `//` comments, no trailing commas. A comment does not produce an
error; the file is silently discarded and none of your settings apply. If a
setting mysteriously does nothing, run it through `jq . ~/.claude/settings.json`
first.

Settings merge across scopes, most specific winning: managed → user
(`~/.claude/settings.json`) → project (`.claude/settings.json`) → local
(`.claude/settings.local.json`). A few keys are deliberately *not* readable from
project scope so a repo can't grant itself privileges — `permissions.defaultMode:
"auto"` and the whole `autoMode` block are the notable ones. Put those in the
user file.

The `$schema` line is optional and gives editors autocomplete and validation. It
is accepted by Claude Code without complaint.

## What's in the example

| Key | Why |
| --- | --- |
| `theme` | Defaults to `"dark"`. `"auto"` follows your terminal's light/dark setting instead. |
| `tui` | `"fullscreen"` uses the alt-screen renderer — no flicker, virtualized scrollback. `"default"` is the classic main-screen renderer. Toggle with `/tui`. |
| `alwaysThinkingEnabled` | Extended thinking on by default for every session, instead of per-session. |
| `effortLevel` | Persists `/effort` across sessions. One of `"low"`, `"medium"`, `"high"`, `"xhigh"`. |
| `autoCompactWindow` | How full the context gets before auto-compaction, in tokens (`100000`–`1000000`). Omit to use the model-tuned default. See below. |
| `attribution` | Drops Claude's bylines. See below. |
| `permissions.defaultMode` | The permission mode at startup. `"auto"` routes tool calls through the classifier instead of prompting. Also accepts `default`/`manual`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. |
| `statusLine` | Runs a script to render the status line. Points at `scripts/statusline.sh` in this repo — **remove this key if you aren't installing that script**, or the status line silently stays empty. |
| `hooks` | A minimal `Notification` hook as a worked example of the shape. It shells out to `~/bin/claude-notify`, which is **not** in this repo — **remove this key** unless you're supplying your own script. See <https://code.claude.com/docs/en/hooks>. |

`~` works in the `statusLine` and `hooks` command paths, so the example needs no
per-machine editing.

## Attribution

Three fields, and they are not the same type — this trips people up:

```json
"attribution": {
  "commit": "",
  "pr": "",
  "sessionUrl": false
}
```

- `commit` and `pr` are **strings**. They default to Claude Code's standard
  byline (`Co-Authored-By: …` on commits, `🤖 Generated with [Claude Code]` in PR
  descriptions). An **empty string** hides them. `false` is not valid here.
- `sessionUrl` is a **boolean**, default `true`. When Claude Code runs from a
  cloud or Remote Control session it appends a `Claude-Session` trailer to
  commits and a link in PR bodies; `false` omits both. It has no effect on
  ordinary local sessions. Requires v2.1.183 or later.

`includeCoAuthoredBy` is the deprecated predecessor. `attribution` is checked
first and wins; only set one.

## Deliberately not in the example

- **`permissions.allow` / `deny` / `ask`** — these are personal trust decisions,
  not something to copy from a stranger. Build yours up with `/permissions`.
  Note that auto mode does *not* make them redundant: `deny` and `ask` rules are
  evaluated before the classifier and still apply, and narrow `Bash(...)` allow
  rules resolve before the classifier runs.
- **`enabledPlugins` / `extraKnownMarketplaces`** — specific to which
  marketplaces you've added.
- **`env`** — machine-specific, and the interesting vars are mostly undocumented.
- **Machine-written state.** Claude Code writes some keys into this file itself:
  `autoMode.skipAutoPermissionPrompt` (whether you've accepted the auto mode
  opt-in dialog) and `feedbackSurveyState` (when the quality survey last
  appeared). Don't hand-set those.

## The auto-compact window

The example sets `autoCompactWindow` to 200k rather than letting a 1M-context
model run to its limit: past roughly 200–300k tokens, usage climbs and
large-context recall degrades ([why][ctx]). Set it to `"auto"` via `/autocompact
reset` if you'd rather have the model-tuned default, which is what Anthropic
recommends.

[ctx]: https://garrit.xyz/posts/2026-05-06-dont-trust-large-context-windows

Prefer this setting over the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var. The env
var only reaches processes launched from that shell, so the desktop app and
cloud sessions miss it — and while it is set, `/autocompact` refuses to change
anything ("CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it
to change this setting.").

`/autocompact` with no argument prints the resolved window *and* where it came
from — `(from settings)`, `(from CLAUDE_CODE_AUTO_COMPACT_WINDOW)`, or a
model default. That's the fastest way to confirm a change took effect.

Note that the actual trigger is the window minus a reserve, not the window
itself, so compaction fires a little early by design.

## Turning off the session quality survey

`feedbackSurveyRate` *looks* like machine-written state and isn't — it's a real
setting, a 0–1 probability that the survey appears when eligible, defaulting to a
server-side value. Set it to `0` to opt out:

```json
"feedbackSurveyRate": 0
```

A literal `0` is honored rather than treated as unset, because both readers use
`??` rather than `||`. `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` is the broader
switch — the rate only gates the quality survey, while the env var also covers
the transcript-sharing asks. Left out of the example because whether to send
Anthropic feedback is your call, not a default worth shipping to strangers.

## Checking your work

`claude doctor` reports invalid settings files, multiple installations, and
update permissions. `claude auto-mode config` prints the effective auto mode
config, which is a quick way to confirm a settings file is actually being read.
