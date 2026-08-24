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

Scheduling is split by *what the task needs to survive*, which is the one
distinction that actually changes the implementation. Naming follows Claude
Code, which draws the same line between `/loop` and `/schedule`.

| | `/once`, `/loop` | `/schedule` |
|---|---|---|
| Runs in | this conversation | a fresh isolated `pi -p` |
| Needs pi open | yes | no |
| Survives quitting pi | no | yes |
| Model | whatever the session is using | per task |
| Stored in | a custom session entry | `~/.pi/agent/scheduler/tasks.json` |
| Missed fires | dropped | caught up once, within a grace window |

Shared schedule parsing lives in `extensions/lib/schedule-core.ts` so a `daily
15:30` means the same thing in both, and in `bin/pi-scheduler`. Neither
extension registers an LLM tool or adds anything to model context.

### Session timers: `/once` and `/loop`

`extensions/session-scheduler.ts`. In-process timers that fire a prompt into
the current conversation.

```text
/once 15m check whether the deploy finished
/once at 8p check in on this
/once remind me about the PR in 2h
/once list | cancel <id>
/loop 15m check CI
/loop review the deploy every 1h
/loop list | cancel <id> | clear
/loop pause <id|all> | resume <id|all>
```

`/once` is the one-shot counterpart to `/loop`. The time may lead (`/once 15m
check the build`, with an optional `in`/`at`) or trail (`/once check the build
in 15m`); the leading form wins when its first token parses as a time, so
`/once 8p check in on this` keeps the prompt's own "in" intact. `/once list`
and `/once cancel` are scoped to one-shots; `/loop list` shows every timer.

`pause` disarms a task's timer but keeps it in the list, so it survives session
resume without firing or drifting. `resume` recomputes the next occurrence rather
than replaying what was missed: a recurring task advances to its next future slot,
and a one-shot whose time passed while paused is dropped with a warning instead of
firing late.

### Durable tasks: `/schedule`

`extensions/durable-scheduler.ts` plus `bin/pi-scheduler`. These run whether or
not pi is open, which is the point: a weekday grade check at 15:30 cannot
depend on a terminal being left running.

```text
/schedule --name grades --model cerebras/gpt-oss-120b:low daily 15:30 :: check the kids' grades
/schedule cron 30 15 * * 1-5 :: weekday grade check
/schedule --misfire always once 8p :: check in on the deploy
/schedule list [all] | show <id> | runs <id>
/schedule run <id> | pause <id> | resume <id> | remove <id>
```

`/schedule run` fires a task now, exactly as the timer would: **its own pi, its
own cwd and model, not this conversation and not this conversation's context.**
It does not block the session — a task's timeout defaults to 15 minutes, and
waiting that long to watch an unattended job is the wrong trade — so the footer
shows what is in flight and the output arrives as a notice when it lands,
without joining the conversation. `runs` (plural) is the read-only history.

Options go **first**, before the schedule: `--name --model --cwd
--with/--without --deliver --misfire --timeout`. Flags are only recognized
while they lead,
because the schedule itself is variable length (a cron expression is five bare
words) and there is otherwise no reliable place to stop scanning — so a prompt
containing `--force` is never mistaken for an option.

The same tasks are managed from the shell, which is also where `install` lives:

```sh
pi-scheduler install          # per-minute launchd job, or systemd --user timer
pi-scheduler list
pi-scheduler add daily 15:30 :: check grades --name grades --model cerebras/gpt-oss-120b:low
pi-scheduler run grades       # ignore the schedule and run now
pi-scheduler runs grades      # recent history
pi-scheduler check            # what the timer calls
```

**Nothing stays resident.** A launchd job (or systemd timer on Linux) runs
`pi-scheduler check` every 60s; it reads one JSON file and exits, measured at
~73ms when nothing is due, so interactive pi startup is untouched. pi is only
spawned when a task is actually due — a due run measured end to end at ~0.65s
against `cerebras/gpt-oss-120b:low`.

Each run is a fresh `pi -p` that loads **what an interactive pi would**: your
extensions, skills, prompt templates, and the `AGENTS.md` of the directory the
task was created in. A task records its cwd at creation, so project context is
the context you had in mind when you wrote the prompt. That means the prompt
can simply be a slash command:

```sh
cd ~/Code/some/repo
pi-scheduler add --name checkin daily 9a :: /checkin
```

Full discovery costs about 0.3s more at startup than a stripped one, which is
nothing for something that runs once a day, and the alternative — a scheduled
run that behaves unlike the pi you tested the prompt in — is a worse trade.

`--without` strips pieces back out: `extensions`, `skills`, `templates`,
`context`, `tools`. `--without tools` makes a run answer-only, worth doing for
anything that just summarizes. `--with` is the inverse allowlist, and `--with
none` is a bare pi — fastest, and immune to a broken extension. Themes have no
switch and are always off: there is no TUI to theme, and `--no-session` is
always passed so an unattended daily job cannot grow a session file forever.

Runs are never messages into an existing session: pi appends to session JSONL
without file locking, so writing into a session that might be open in a
terminal risks interleaved entries. Each run is its own pi, which is also why
a task carries its own `--model` rather than inheriting whatever a human left
selected three days ago.

`--deliver` is a shell command that receives the output on stdin and in
`$PI_SCHEDULER_OUTPUT`; the prompt and the result both travel by stdin rather
than argv, so neither shows up in `ps`. Collect data with a deterministic
script first and let the model only summarize it:

```sh
pi-scheduler add --name grades --model cerebras/gpt-oss-120b:low \
  --deliver 'fnox exec -- slack-noti' \
  cron 30 15 * * 1-5 :: 'Summarize these grades and flag anything below 80.'
```

`--misfire` decides what a late run does, because the Mac sleeps: `skip` never
runs late, `always` always does, and a duration (default `2h`) is the window
within which a catch-up is still wanted. Late runs **coalesce** — one catch-up,
never a replay of every missed slot.

The registry is `~/.pi/agent/scheduler/`, mode 0700 with 0600 files, since
prompts and run output are routinely private. Read-modify-write goes through a
`mkdir` mutex held only for the JSON round trip; the agent run itself happens
outside the lock, guarded instead by a claim recorded on the task, so two
overlapping ticks cannot double-run one job and a runner that dies has its
claim reclaimed rather than wedging the task forever.

### Cron syntax

Both schedulers take a standard 5-field crontab expression (minute, hour, day-of-month,
month, day-of-week) with ranges, lists, `*/n` steps, and `jan`/`mon` style names,
plus the `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` macros. When
both day-of-month and day-of-week are restricted they are OR'd, matching Vixie
cron. There is no seconds field — a 6-field expression is rejected rather than
reinterpreted, and an expression that can never match (`0 0 30 2 *`) is refused
at creation.

Session timers live in custom session entries, so they restore when you resume
that session and are not inherited by `/new`, `/fork` or `/clone`. Pi must be
running; missed fires are skipped rather than replayed after resume. Recurring
intervals have a one-minute minimum, in both schedulers.

One edge case for session timers, from pi's `SessionManager._persist`: pi does
not create the session file until the session holds at least one assistant
message. A timer set before that is buffered in memory and is written out with
the first reply — but one set in a session that never prompts the model is lost
on exit. `/once` and `/loop` warn when they detect this state, and the task is
still created. `/schedule` is immune, since it writes to its own registry.

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
