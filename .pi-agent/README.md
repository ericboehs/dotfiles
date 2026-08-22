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

## Session scheduler

`extensions/session-scheduler.ts` provides in-process, session-scoped prompts
without registering an LLM tool or adding anything to model context:

```text
/loop 15m check CI
/schedule hourly check status
/schedule daily 9a write a morning summary
/schedule once 30m check the build
/schedule list
/schedule cancel <id>
```

Schedules live in custom session entries, restore with that session, and are
cleared by `/new` or a fork. Pi must be running; missed fires are skipped rather
than replayed after resume. Recurring intervals have a one-minute minimum.

Intentionally left as machine-local runtime state:

- `auth.json` and other credentials
- `sessions/`
- downloaded `npm/` and `git/` packages
- generated model catalog and cache files
- `models.json`, which may contain machine-specific provider configuration
- trust decisions
- `boot-times.jsonl`, the launch log behind `/boot stats`
- `.pi-agent/node_modules/`, the symlinks `bin/pi-ext-check` creates
- `dist/bundle.mjs` inside the pi install, which `bin/pi-bundle` rebuilds
