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
| `autoCompactWindow` | How full the context gets before auto-compaction, in tokens (`100000`–`1000000`). Omit to use the model-tuned default. Prefer this over the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var so it applies in the desktop app and cloud sessions too, not just your shell. |
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
  `skipAutoPermissionPrompt` (whether you've accepted the auto mode opt-in
  dialog), `feedbackSurveyState`, `feedbackSurveyRate`. Don't hand-set them.

## Checking your work

`claude doctor` reports invalid settings files, multiple installations, and
update permissions. `claude auto-mode config` prints the effective auto mode
config, which is a quick way to confirm a settings file is actually being read.
