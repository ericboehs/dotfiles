# Pi configuration

Reproducible configuration for [`pi`](https://pi.dev), installed by
`mise bootstrap` through the `bootstrap:pi` task.

Tracked here:

- Pi settings and pinned package sources, one file per host
- custom keybindings (e.g. Opt+Enter inserts a newline)
- approval-guardian policy
- local TypeScript extensions, plus the tooling to check them
- prompt templates, and the vendored design skills behind `/artifact`

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

### Edit through the link, never over it

`~/.pi/agent/settings.json` is a symlink to the file above, so anything that
*replaces* it rather than writing into it — `jq … > tmp && mv tmp
~/.pi/agent/settings.json` is the easy way to get this wrong — swaps the link
for a regular file. Nothing complains: pi reads the new file happily, and the
edit appears to have worked. Then `bootstrap:pi` finds a real file where a link
belongs, moves it aside as `settings.json.bak`, and relinks — and every change
made since is in the `.bak`, not in effect. The tell is a session that comes
back missing packages you know you installed.

Write through the link:

```sh
jq '…' ~/.pi/agent/settings.json > /tmp/s.json && cat /tmp/s.json > ~/.pi/agent/settings.json
```

Better, edit `settings.<host>.json` here and commit it — the change is then on
every host rather than one. `pi install` and `pi remove` are safe either way:
they rewrite in place, so their edits land in the tracked copy.

The same holds for every other file `bootstrap:pi` links — `keybindings.json`,
`models.json`, the assistant profile's `AGENTS.md`, `approval-guardian.json`
and `prompts/`. Each one has a bootstrap step that will quietly restore the
link over whatever replaced it.

Three things now say so out loud, because the gap between the mistake and the
symptom is what made it expensive:

```sh
bin/pi-profile-check --links-only   # audit both profiles (~35ms)
```

- `bin/pi-launch` tests three managed paths on every launch — three shell
  builtins, no subprocess — and prints a warning before starting pi. A clobber
  is announced at the next session rather than at the next bootstrap.
- The `pre-dotfiles` hook runs the audit *before* mise relinks, so the paths it
  is about to rename are named while their contents still matter.
- The audit also catches the quieter variants: a link left pointing at another
  host's `settings.<host>.json` after a rename, and a dangling one.

## Assistant profile (`pia`)

`pia` is not a second Pi installation. The shell function in
`.zsh/functions.zsh` runs the same `pi` executable with
`PI_CODING_AGENT_DIR=~/.pi/assistant`. The second agent directory keeps life
and work operations out of the coding profile without duplicating resources
that should behave identically.

`bootstrap:pi-assistant` builds the boundary as follows:

| Resource | Relationship | Reason |
| --- | --- | --- |
| Pi executable | shared | `pia()` invokes `pi`, so upgrades apply to both |
| `auth.json`, `models.json`, `keybindings.json` | symlinked from `~/.pi/agent` | same credentials, providers, and controls |
| `npm/`, `git/`, `bin/` | symlinked from `~/.pi/agent` | one downloaded package/tool cache; package declarations are still separate |
| `extensions/` | symlinked to this repo's `.pi-agent/extensions` | every tracked local extension loads in both profiles |
| `enabledModels` | copied by `pia()` at launch and copied back on exit if changed | Pi stores the Ctrl+P scope inside otherwise-separate settings files |
| `settings.json` other than `enabledModels` | separate | packages, skills, defaults, theme, and profile behavior can differ |
| `AGENTS.md`, `approval-guardian.json`, `prompts/` | separate, linked from the private assistant source | assistant persona and workflows do not belong in the published coding config |
| sessions, memory, trust, and other runtime state | separate | preserves the isolation that the second profile exists to provide |

Because `extensions/` is shared while package declarations are separate, a
vendored extension can replace a package in the coding settings but leave the
assistant settings stale. Replacement extensions mark the old source with an
`@replaces` comment. `bin/pi-profile-check` detects any marked package still
loaded beside its replacement — and, with the link audit above, any managed
path in either profile that is no longer the link bootstrap made. Both Pi
bootstrap tasks run it. Run it by hand after changing either profile:

```sh
bin/pi-profile-check                # packages and links, both profiles
bin/pi-profile-check --links-only
bin/pi-profile-check --packages-only
```

The list of managed paths is read out of `mise.toml`'s dotfiles table rather
than repeated in the checker, so a link added there is audited without touching
the script. The two per-host links (`settings.json`, `models.json`) are the
exception: `bootstrap:pi` makes those itself, and the checker resolves the host
the same way it does.

Do not symlink the complete settings file or blindly copy package and skill
lists between profiles; that would erase the useful boundary. Put truly shared
behavior in the linked resources above, and synchronize individual settings
explicitly when both profiles need them.

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

A `pre-push` hook runs the same check automatically. It is wired up globally in
`.gitconfig` as a config hook (git 2.36+ `[hook "pi-extensions"]`) and scopes
itself by exiting silently in any repo without a `bin/pi-ext-check`, so pushes
elsewhere are unaffected. Two details worth knowing:

- It checks a **detached worktree built from the pushed sha**, never the working
  tree. Several agent sessions share this clone, so the tree usually holds
  someone else's half-finished file; the commit that lands is what has to pass.
  This is also why it does not use `git stash`, which mutates shared state.
- It only runs when the pushed commits touch `.pi-agent/` (0.2s otherwise, ~15s
  when it does), and it lets the push through with a warning on a machine with
  no globally installed pi, where the check cannot run at all.

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

### OpenRouter route chip

The model chip names the upstream provider OpenRouter picked: `or novita/oxa`,
`or z/oxa`, `or modal/oxa`. OpenRouter reports the decision in
`openrouter_metadata`, opted into per request with `X-OpenRouter-Metadata:
enabled`, and delivers it in the response *body* — the last SSE chunk before
`[DONE]`. pi hands extensions only status and headers
(`after_provider_response`), so `extensions/openrouter-route.ts` wraps
`globalThis.fetch` instead: pi-ai builds its OpenAI client per request and
resolves fetch through the SDK's `getDefaultFetch()`, which reads the current
global. The wrapper adds the header, streams the body through a pass-through
transform that watches for the metadata line, and stashes the selected provider
for the footer. Non-OpenRouter requests, error responses and empty bodies are
handed back untouched.

The documented alternative costs an API call per turn: pi records OpenRouter's
generation id on the assistant message as `responseId`, and
`GET /api/v1/generation?id=` reports `provider_name`. Cache hits never carry
routing data either way, so the chip keeps the last known route for the model.

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

## Model briefings

`extensions/aa-info.ts` prints one dim status line into the chat whenever a
model is selected (startup, `/model`, Ctrl+P) and lets it scroll away with the
conversation:

```text
Claude Opus 5 — int 62.5 · cod 77 · 53t/s · $10/1M · $1.80/task (AA)
Grok 4.6 — int 60 · cod 75.9 · 60t/s · $3/1M · $0.78/task@med (AA)
```

It lands in place of pi's own `Switched to …` line, because pi overwrites its
last status line rather than appending; models only cycled past stay quiet.

`int`, `cod`, `t/s`, and `$/1M` use AA's row for pi's current thinking level,
falling back to AA's bare/max row only when that effort has no row. `$/1M` is
the sticker rate (every model has one); `$/task` is what one Intelligence Index
task cost AA to run, which folds in how many tokens the model burns thinking.
AA only measures one or two effort levels per model for the task-cost endpoint,
so a trailing `@med` marks a task cost measured at a different effort than the
session runs — it swings ~4x across the ladder. Latency is omitted on purpose:
AA's own site and API disagree about it by more than 2x for the same variant.

Data comes from two free Artificial Analysis endpoints (`data/llms/models` for
quality, speed and rate; `language/models/free` for $/task), fetched once a
week and cached together in `~/.pi/agent/cache/aa-models.json`. The fetch is
fire-and-forget — neither startup nor the model switch waits on it — and a
model the API does not know (local oMLX weights) or a failed fetch shows
nothing. The key resolves from `$ARTIFICIAL_ANALYSIS_API_KEY`, then `fnox get`
(Keychain), like the web providers; nothing touches the LLM context.

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

## Artifacts

`/artifact` builds one self-contained HTML page and publishes it to a shareable
URL — Claude's Artifacts "Publish" button, reproduced with a prompt template and
two scripts.

```text
/artifact a dashboard for my solar production data
```

### A prompt template, not a skill

Skills announce themselves in the system prompt on every turn; a name and
description sit in context forever whether or not they are ever used. Prompt
templates cost nothing until typed. Building an artifact is always a deliberate
act — never something the model should decide to start on its own — so
`prompts/artifact.md` is the right shape: ~940 tokens that are free until
invoked, and which then pull in one skill file for ~3,000 tokens on a typical
run.

### The design guidance is vendored, not written

`artifact-skills/` holds Anthropic's own design skills, copied verbatim from
[`anthropics/skills`](https://github.com/anthropics/skills) (Apache 2.0) and
pinned by commit in `MANIFEST`. Only `SKILL.md` and `LICENSE.txt` are
taken; the upstream scripts and assets are not.

| Skill | Tokens | Read when |
| --- | --- | --- |
| `frontend-design` | ~2,060 | always — the core methodology |
| `web-artifacts-builder` | ~770 | React, state, shadcn |
| `algorithmic-art` | ~4,940 | generative visuals, p5.js |
| `canvas-design` | ~2,980 | static poster or PDF |
| `brand-guidelines` | ~560 | Anthropic brand |

`artifact.md` names that table and tells the agent which file to read, so a
plain data dashboard never loads the 4,940-token art skill. Pinning matters for
the same reason it does for packages: upstream edits should not silently change
what the prompt does.

```sh
bin/artifact-skills-sync            # sync to the pinned commit
bin/artifact-skills-sync --check    # has upstream moved?
bin/artifact-skills-sync --update   # repin, then review the diff
bin/artifact-skills-sync --list     # token estimates
```

This directory is published, and `.gitignore` here is a deny-by-default
allowlist, so the vendored files need explicit rules to be tracked at all.

**Do not hand-write a design system for this.** The first version did — fixed
`:root` tokens plus six named layout archetypes — and every page it produced
looked the same, because a fixed token set is a house style with extra steps.
Worse, it landed on a warm cream background with a serif display face and a
terracotta accent, which is the first of the three AI-default clusters
`frontend-design` calls out by name. The real skill inverts the approach: name
the subject and the page's single job, invent a bespoke palette and type scale
per brief, then critique that plan against a generic answer to the same prompt
before writing any code.

The test that it is working is that two artifacts from the same pipeline share
no palette, typeface, hero pattern or layout axis.

### Screenshot it before publishing

Rendering and looking at the result caught ten defects across the first two
artifacts that were invisible in the source, two of them CSS specificity bugs
of exactly the kind the skill warns about: a `font:` shorthand on a parent
silently overriding a child rule that set only size and weight, and a CSS
`fill` rule beating an SVG `fill` attribute. Both produced valid, error-free
pages that were simply wrong.

Playwright cannot load `file://` on macOS, so serve the directory first:

```sh
python3 -m http.server 8899
playwright-cli -s=art open http://localhost:8899/page.html
```

Check 375 / 768 / 1440, both color schemes, and every interactive state
including the empty one.

### Publishing

```sh
pub report.html              # publish; URL printed and copied
pub -u <gist-id> file.html   # revise in place, URL unchanged
pub -l                       # list
pub -r <gist-id>             # delete
```

`bin/pub` writes the file to a secret gist as `index.html` and hands back a
`gistpreview.github.io/?<id>` URL. Transport limits worth knowing: secret gists
are *unlisted*, not private; the renderer is third-party and volunteer-run
(`bl.ocks.org`, the same idea, is dead); there is no control over CSP, so a
page could beacon data out; and there is no versioning or expiry. `artifact.md`
therefore ends with an explicit check for secrets, tokens, internal hostnames,
PII and client-internal material before anything is published — anything that
fails it stays local.

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
