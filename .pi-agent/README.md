# Pi configuration

Reproducible configuration for [`pi`](https://pi.dev), installed by
`mise bootstrap` through the `bootstrap:pi` task.

Tracked here:

- Pi settings and pinned package sources, one file per host
- custom keybindings (e.g. Opt+Enter inserts a newline)
- approval-guardian policy
- `boehsline.json`, the settings for [Boehsline](https://github.com/ericboehs/pi-boehsline), which holds the extensions
- the few local extensions left (generated ones, and experiments), plus the tooling to check them
- prompt templates, the vendored design skills behind `/artifact`, and the vendored `html-plan` skill behind `/html-plan`

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
`models.json`, `approval-guardian.json` and `prompts/`. Each one has a
bootstrap step that will quietly restore the link over whatever replaced it.

Three things now say so out loud, because the gap between the mistake and the
symptom is what made it expensive:

```sh
bin/dotfiles-link-check ~/.pi      # or with no argument, the whole tree
bin/pi-profile-check --links-only  # the same audit, scoped to the profiles
```

- `bin/pi-launch` tests three managed paths on every launch — three shell
  builtins, no subprocess — and prints a warning before starting pi. A clobber
  is announced at the next session rather than at the next bootstrap.
- The `pre-dotfiles` hook runs the audit *before* mise relinks, so the paths it
  is about to rename are named while their contents still matter.
- The audit also catches the quieter variants: a link left pointing at another
  host's `settings.<host>.json` after a rename, and a dangling one.

## Assistant profile (retired)

The `pia` profile was a second agent directory at `~/.pi/assistant`, linked by
`bootstrap:pi-assistant` from a private source and launched by a `pia()` shell
function that also synced `enabledModels` between the two settings files. It
was retired in favor of assistant work running in this profile: the
`/assistant` prompt template (in the private prompts directory) loads the
assistant skills on demand and carries the confirm-before-send rules.

`bin/pi-profile-check` audits the profile's packages and links, delegating the
link audit to `bin/dotfiles-link-check`. Run it by hand after changing the
profile:

```sh
bin/pi-profile-check                # packages and links
bin/pi-profile-check --links-only
bin/pi-profile-check --packages-only
```

The list of managed paths is read out of `mise.toml`'s dotfiles table rather
than repeated in the checker, so a link added there is audited without touching
the script — including the `symlink-each` directories, whose contents are the
links. The links the bootstrap tasks make themselves are the exception and are
named in `dotfiles-link-check`: the two per-host ones (`settings.json`,
`models.json`, whose host it resolves the same way `bootstrap:pi` does), and
the VA context file.

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

## Extensions

The pi extensions live in [Boehsline](https://github.com/ericboehs/pi-boehsline)
(`~/Code/github.com/ericboehs/pi-boehsline`), each with its own README:
footer, canvas, watch, meeting, web, bg, compaction and the rest, plus the
bundled pi-context, pi-scheduler, pi-agent-link, pi-approval-guardian and
pi-goal. `settings.<host>.json` loads it as a package (a local checkout on e14,
a pinned commit elsewhere); `boehsline.json`, linked to
`~/.pi/agent/boehsline.json`, turns on its opt-ins and holds personal paths;
work settings come from the private pi-boehsline-va package. Only
`moshi-hooks.ts`, `herdr-agent-state.ts` (both generated) and `skill-modes.ts`
stay in `extensions/` here.

## Launch speed

The Boehsline footer reruns `bin/pi-bundle` in the background when it sees a
new pi install, since an update leaves the bundle stale and every launch about
115ms slower until it's rebuilt.

`bin/pi-launch` points node's V8 compile cache at `~/.cache/pi/v8`, worth
about 75ms a launch. Compiling the bundle is the largest single thing pi does before
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
pinned by commit in `MANIFEST`, and every file by sha256 as well. Only `SKILL.md`
and `LICENSE.txt` are taken; the upstream scripts and assets are not.

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
bin/artifact-skills-sync --verify   # files match MANIFEST, and git carries them?
bin/artifact-skills-sync --check    # has upstream moved?
bin/artifact-skills-sync --update   # repin, then review the diff
bin/artifact-skills-sync --list     # token estimates
```

`--verify` is the one CI runs, and it touches nothing but the working tree: MANIFEST
records the sha256 of every vendored file, so holding the pin needs no network and no
`gh auth`. Upstream moving is a reminder to repin by hand, never a red build.

This directory is published, and `.gitignore` here is a deny-by-default
allowlist, so the vendored files need explicit rules to be tracked at all. `--verify`
checks that too — a vendored file with no `!` rule works locally and is simply
missing in CI, which is the one failure a local run otherwise cannot predict.

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

Part of Boehsline, as the `packages/scheduler` subtree (formerly
[pi-scheduler](https://github.com/ericboehs/pi-scheduler), now archived). `/once` and `/loop` are
session timers that fire a prompt into the current conversation; `/schedule`
plus the `pi-scheduler` CLI are durable tasks that run in their own `pi -p`
whether or not pi is open. Neither registers an LLM tool or adds anything to
model context. The full reference is `packages/scheduler/README.md` in Boehsline.

`bin/pi-scheduler` here is a small shim: `~/bin` is a symlink to `bin/`, so the
shim keeps the command on PATH on every host. It runs the local Boehsline
checkout if there is one, else the copy `pi install` cloned into
`~/.pi/agent/git`. It **execs** the package's
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
