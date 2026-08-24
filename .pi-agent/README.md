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
`extensions/` rather than inside it: mise links that directory as a whole to
`~/.pi/agent/extensions`, so anything in it becomes something pi tries to load.
A whole-directory link also makes extensions added by a later git pull appear
immediately; the old `symlink-each` layout required another bootstrap run for
every new file. During that one-time migration, the pre-dotfiles hook preserves
the previous directory as `~/.pi/agent/extensions.symlink-each.bak`.

## Footer

`extensions/footer.ts` renders the status line (dir, provider, model, git,
context/cost, boot time) plus `/bypass`, `/boot` and `/footer`. It also watches
pi's on-disk version: when an install lands while instances are running — via
`pi update`, `npm i -g`, anything — each running footer shows a green, right-aligned
"Update installed v0.52.1 → v0.53.0 · Restart to update" line above the prompt
within ~30s, like Claude Code.

The same detection kicks off `bin/pi-bundle` in a detached background process,
since an update leaves the bundle stale and every launch ~115ms slower until it
is rebuilt. Concurrent pi instances serialize on a lock directory; output lands
in `~/.pi/agent/auto-bundle.log`. Set `PI_NO_AUTO_BUNDLE=1` to opt out.

`bin/pi-launch` also points node's V8 compile cache at `~/.cache/pi/v8`, worth
another ~75ms. Compiling the bundle is the largest single thing pi does before
`main()` — 8.7MB in one file — and it produces the same bytes every launch:

| phase | cost |
| --- | --- |
| node itself | 30ms |
| compiling the bundle | ~320ms |
| `createAgentSessionRuntime` | 131ms |
| `interactiveMode.init` | 161ms |
| all 21 extensions | 45ms |

Node namespaces the cache by version, arch and build id and keys entries by
source hash, so an upgrade misses rather than running stale code, and
`pi-bundle` clears it on each rebuild so it does not grow by ~1.4MB per
release. `PI_NO_COMPILE_CACHE=1` opts out; `pi-bundle --status` shows its size.

Interleaved A/B on one machine, best of 6 launches each:

| entrypoint | boot |
| --- | --- |
| stock `dist/cli.js` | 693ms |
| bundle only | 590ms |
| bundle + compile cache | 528ms |

`bootstrap:pi` also symlinks the system `fd` and `rg` into `~/.pi/agent/bin`.
pi probes for both with `spawnSync(tool, ["--version"])` on every TUI launch and
downloads its own copies if they are missing, but `getToolPath()` checks that
directory first — so seeding it turns three spawns into two `existsSync` hits,
worth ~17ms.

What is left, from `node --cpu-prof` over a 552ms launch (default sampling
interval; `--cpu-prof-interval 100` inflates blocking syscalls badly enough to
report a 339ms `spawnSync` that is really 17ms):

| | cost |
| --- | --- |
| evaluating the bundle | ~149ms |
| idle, waiting on I/O | ~106ms |
| `!security find-generic-password` for the Copilot key in `auth.json` | 24ms |
| compiling the extensions | 22ms |
| `mergeModels` over `models.<host>.json` | 14ms |
| `probeTmuxHyperlinks` | 14ms |
| grapheme width measurement | 12ms |
| GC | 11ms |

Nothing below the top two is worth chasing, and both belong to pi rather than
to anything configured here.

Every cold start is appended to `boot-times.jsonl` with the gap back to the
previous launch and the 1-minute load average, and `/boot stats` reports the
two cohorts separately. This is not decoration: relaunching pi a few times in a
row boots ~350ms faster than a one-off launch, purely from a warm page cache
and an idle machine. Measured on one machine, same commit, minutes apart:

| launch | gap since previous | boot |
| --- | --- | --- |
| one-off | 743s | 972ms |
| relaunch | 13s | 600ms |
| relaunch | 6s | 607ms |

That spread is wider than most changes worth measuring, so an undivided p50
mostly reports how you happened to be using pi that day — and a benchmark burst
sitting next to real launches reads as a regression that was never there.
Compare cohort to cohort.

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

## Schedulers

Moved out to its own package: **[pi-scheduler](https://github.com/ericboehs/pi-scheduler)**,
installed from `packages` in the per-host settings. `/once` and `/loop` are
session timers that fire a prompt into the current conversation; `/schedule`
plus the `pi-scheduler` CLI are durable tasks that run in their own `pi -p`
whether or not pi is open. Neither registers an LLM tool or adds anything to
model context. The full reference lives in that repo's README.

`bin/pi-scheduler` here is a two-line shim: `~/bin` is a symlink to `bin/`, so
the shim is what keeps the command on PATH on every host without each one
needing a hand-made symlink into `~/.pi/agent/git`. It **execs** the package's
CLI rather than wrapping it, because `pi-scheduler install` bakes an absolute
path into the launchd job and that path must be the package's, not the shim's.

The registry stays machine-local at `~/.pi/agent/scheduler/` — see below.


Intentionally left as machine-local runtime state:

- `auth.json` and other credentials
- `sessions/`
- downloaded `npm/` and `git/` packages
- generated model catalog and cache files
- `models.json`, which may contain machine-specific provider configuration
- trust decisions
- `boot-times.jsonl`, the launch log behind `/boot stats`
- `scheduler/`, the durable task registry and run history behind `/schedule`
- `auto-bundle.log` and `pi-bundle.lock`, written by the footer's automatic bundle rebuild
- `~/.cache/pi/v8`, the V8 compile cache `bin/pi-launch` points node at
- `.pi-agent/node_modules/`, the symlinks `bin/pi-ext-check` creates
- `dist/bundle.mjs` inside the pi install, which `bin/pi-bundle` rebuilds
