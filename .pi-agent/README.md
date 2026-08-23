# Pi configuration

Reproducible configuration for [`pi`](https://pi.dev), installed by
`mise bootstrap` through the `bootstrap:pi` task.

Tracked here:

- Pi settings and pinned package sources, one file per host
- custom keybindings (e.g. Opt+Enter inserts a newline)
- approval-guardian policy
- local TypeScript extensions, plus the tooling to check them

## Per-host settings

`settings.<host>.json` is linked to `~/.pi/agent/settings.json` by
`bootstrap:pi`, named after `hostname -s`. A new machine is seeded from
`settings.default.json`, which holds only the machine-neutral preferences — no
providers, packages, skills, or terminal capabilities.

This directory is published, and some hostnames are asset tags. To pick the
name yourself, write it into `.pi-agent/host` (untracked) or export
`PI_SETTINGS_HOST`; either one wins over `hostname -s`.

One shared `settings.json` does not survive two machines. Pi rewrites the file
as you work (model switches, `lastChangelogVersion`, dismissed warnings), so
every host carried a permanent uncommitted diff of it and every pull was a
conflict waiting to happen. Splitting it also lets each host enable only what
it can actually reach: the Linux box has no local oMLX server and no Copilot
credentials, and naming them there printed a warning on every launch.

The runtime writes land in a tracked file on purpose — `git diff` after a week
shows exactly what pi changed on its own.

## Checking the extensions

```sh
bin/pi-ext-check                  # typecheck + smoke tests
bin/pi-ext-check --typecheck-only
bin/pi-ext-check --test-only
```

The extensions are typechecked against the globally installed pi rather than a
vendored dependency: `pi-ext-check` symlinks `.pi-agent/node_modules` to that
install (`@earendil-works/pi-coding-agent`, `pi-tui`, `typebox`, `@types/node`)
and runs `tsc` from `npx`. `tsconfig.json` sets `erasableSyntaxOnly`, because pi
loads `.ts` extensions through Node's type stripping — syntax that needs real
compilation (parameter properties, enums, namespaces) fails at load time
otherwise.

`tsconfig.json`, `package.json` and `test/` deliberately sit beside
`extensions/` rather than inside it: mise links that directory into
`~/.pi/agent/extensions` with `symlink-each`, so anything in it becomes
something pi tries to load.

## Footer

`extensions/footer.ts` renders the status line (dir, provider, model, git,
context/cost, boot time) plus `/bypass`, `/boot` and `/footer`. It also watches
pi's on-disk version: when an install lands while instances are running — via
`pi update`, `npm i -g`, anything — each running footer shows a green
"Update installed · Restart to update" segment within ~30s, like Claude Code.

The same detection kicks off `bin/pi-bundle` in a detached background process,
since an update leaves the bundle stale and every launch ~115ms slower until it
is rebuilt. Concurrent pi instances serialize on a lock directory; output lands
in `~/.pi/agent/auto-bundle.log`. Set `PI_NO_AUTO_BUNDLE=1` to opt out.

## Session color

`extensions/color.ts` adds `/color`, Claude Code's trick for telling four
identical panes apart:

```text
/color              # picker
/color blue         # red orange yellow green cyan blue purple pink gray
/color #ff0088      # any hex, long or short (#f08)
/color 204          # xterm palette index; bare digits beat hex shorthand
/color auto         # derived from the session name, stable across /reload
/color list         # the palette, swatched
/color off          # back to the theme
```

It recolors the editor border only, by cloning the live theme with the seven
thinking-level tokens overwritten — nothing else in pi reads those, so the
transcript, tools and syntax colors stay exactly as the theme author wrote
them. `bashMode` is left alone, so `!` still flips the border to its own color.
The footer paints the session name in the same color, but only a name you set
with `/name`: a name pi-claude-link derived for the peer registry stays dim,
since it says "nobody named this" and a bright color would claim otherwise.
Like Claude's, the choice is not persisted: it lives in the process (through
`/reload`, via a `globalThis` stash) and dies with it.

Two side effects of handing pi a theme instance instead of a name, both
cleared by `/color off`: the theme file watcher stops, so editing the active
custom theme's JSON no longer hot-reloads, and `light/dark` auto-switching
stops following the terminal. Picking a theme in `/settings` drops the tint;
the next `/color` re-tints from whatever is current.

## Session scheduler

`extensions/session-scheduler.ts` provides in-process, session-scoped prompts
without registering an LLM tool or adding anything to model context:

```text
/loop 15m check CI
/schedule hourly check status
/schedule daily 9a write a morning summary
/schedule cron 0 9 * * 1-5 weekday standup
/schedule cron @hourly check status
/schedule once 30m check the build
/schedule list
/schedule pause <id|all>
/schedule resume <id|all>
/schedule cancel <id>
```

`pause` disarms a task's timer but keeps it in the list, so it survives session
resume without firing or drifting. `resume` recomputes the next occurrence rather
than replaying what was missed: a recurring task advances to its next future slot,
and a one-shot whose time passed while paused is dropped with a warning instead of
firing late.

`cron` takes a standard 5-field crontab expression (minute, hour, day-of-month,
month, day-of-week) with ranges, lists, `*/n` steps, and `jan`/`mon` style names,
plus the `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` macros. When
both day-of-month and day-of-week are restricted they are OR'd, matching Vixie
cron. There is no seconds field — a 6-field expression is rejected rather than
reinterpreted, and an expression that can never match (`0 0 30 2 *`) is refused
at creation.

Schedules live in custom session entries, so they restore when you resume that
session and are not inherited by `/new`, `/fork` or `/clone`. Pi must be running;
missed fires are skipped rather than replayed after resume. Recurring intervals
have a one-minute minimum.

One edge case, from pi's `SessionManager._persist`: pi does not create the session
file until the session holds at least one assistant message. A schedule made
before that is buffered in memory and is written out with the first reply — but a
schedule made in a session that never prompts the model is lost on exit.
`/schedule` warns when it detects this state, and the task is still created.

Intentionally left as machine-local runtime state:

- `auth.json` and other credentials
- `sessions/`
- downloaded `npm/` and `git/` packages
- generated model catalog and cache files
- `models.json`, which may contain machine-specific provider configuration
- trust decisions
- `boot-times.jsonl`, the launch log behind `/boot stats`
- `auto-bundle.log` and `pi-bundle.lock`, written by the footer's automatic bundle rebuild
- `.pi-agent/node_modules/`, the symlinks `bin/pi-ext-check` creates
- `dist/bundle.mjs` inside the pi install, which `bin/pi-bundle` rebuilds
