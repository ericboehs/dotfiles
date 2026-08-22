# dotfiles

Personal dotfiles optimized for macOS and zsh. Features modern shell tools, comprehensive git configuration, and a customized development environment.

## Installation

```sh
curl -fsSL https://mise.run | sh
git clone https://github.com/ericboehs/dotfiles ~/Code/github.com/ericboehs/dotfiles
cd ~/Code/github.com/ericboehs/dotfiles && mise trust && mise bootstrap
```

Install mise from `mise.run`, not Homebrew. mise bootstraps itself, so it is
deliberately absent from `[bootstrap.packages]` — whichever copy you install by
hand is the one that runs. Homebrew's build disables `mise self-update` and
lags upstream, and because it lands in `/opt/homebrew/bin` instead of
`~/.local/bin` it papers over a real bug: mise's rubygems plugin shells out to
`mise reshim` after installing any gem with executables, so mason's gem-backed
packages fail on a `mise.run` machine unless that directory is on `PATH`.

Setup is declared in [mise.toml](mise.toml) rather than scripted, so it
converges — re-running only changes what has drifted. Requires mise 2026.8.4
or newer for the per-package `os` filters; older versions say so and stop.
Useful variations:

```sh
mise bootstrap -n                     # preview every change, touch nothing
mise bootstrap --only dotfiles        # just the $HOME symlinks
mise bootstrap --skip macos-defaults  # leave system preferences alone
mise bootstrap dotfiles status        # what's linked, and what has drifted
```

Dotfile linking is all-or-nothing: if $HOME already has real files where
symlinks belong, mise names them and refuses the whole step. `--force-dotfiles`
overrides that, but it *replaces* those files rather than merging them — on a
machine where Homebrew or rbenv had written their own `.zprofile`, that content
is gone. Move anything you want to keep aside first.

One caveat on convergence: the `tools` step runs before the `bootstrap` task,
and a single failed download there — mise resolves runtime versions from
GitHub's releases API, so a GitHub incident is enough — aborts the run before
the task ever starts. The output still reads like a finished bootstrap. If
neovim and tmux look unwarmed, re-run; it picks up where it left off.

Configure git with your personal information:
```sh
cp ~/.gitconfig.private.example ~/.gitconfig.private
$EDITOR ~/.gitconfig.private
```

## Core Components

### Shell (zsh)

- **Prompt**: [Starship](https://starship.rs/) - Fast, customizable prompt
- **Syntax highlighting**: [fast-syntax-highlighting](https://github.com/zdharma-continuum/fast-syntax-highlighting)
- **Autosuggestions**: [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions)
- **Smart cd**: [zoxide](https://github.com/ajeetdsouza/zoxide) - Directory jumper that learns your habits
- **Abbreviations**: Custom expansion system (see [.zsh/abbreviations.zsh](.zsh/abbreviations.zsh))
  - Type abbreviation + space/enter to expand
  - Extensive git shortcuts (e.g., `gco` → `git checkout`, `gs` → `git status`)
  - GitHub CLI helpers for PRs and workflow runs
- **Notifications**: Auto-notify for long-running commands

### Editor (Neovim)

- Configuration: [LazyVim](https://www.lazyvim.org/)
- Location: `.config/nvim/`
- Custom plugins for CSV, Markdown, Tailwind, and GitHub integration

### Terminal Multiplexer (tmux)

- Prefix: `Ctrl-B` (default)
- Plugins: vim-tmux-navigator, tmux-yank, tmux-copycat, tmux-floax
- Features:
  - Vi-mode copy/paste
  - Mouse support
  - Activity and bell monitoring
  - Custom status line with zoom indicator
  - Auto-renumber windows

### Version Management and Setup

- **Tool**: [mise](https://mise.jdx.dev/) (replaces asdf)
- Manages Node.js, Ruby, Python, and other language runtimes
- Also drives machine setup — packages, `$HOME` symlinks, macOS defaults and
  git checkouts are all declared in [mise.toml](mise.toml) and applied with
  `mise bootstrap`

### Pi coding agent

- Pi itself and its extension packages are version-pinned through mise.
- Stable configuration and local extensions live in [`.pi-agent/`](.pi-agent/).
  Settings are per host (`settings.<hostname>.json`) because pi rewrites them
  at runtime; `bootstrap:pi` links the right one and seeds new machines from
  `settings.default.json`.
- `bootstrap:pi` installs and verifies the pinned package set without tracking
  credentials, sessions, caches, or downloaded package contents.
- `bootstrap:pi` then runs `bin/pi-bundle`, which bundles pi's ~200-module Node
  build into one file and points the `pi` bin at `bin/pi-launch`. Worth ~115ms
  per launch (716ms → 602ms to first frame here, 738ms → 616ms on Linux), plus
  another 32ms from `PI_BUNDLE_NO_BEDROCK=1`, which drops the AWS SDK that
  neither machine authenticates. The launcher falls back to the stock
  entrypoint if the bundle is missing or older than the package, so an upgrade
  costs speed rather than a working pi; `pi-bundle --off` reverts and
  `PI_NO_BUNDLE=1` skips it for one launch.

### Fuzzy Finder

- **Tool**: [fzf](https://github.com/junegunn/fzf)
- Keybindings:
  - `Ctrl-R`: Command history search (with regex support)
  - `Ctrl-T`: File search
- Enhanced with preview windows and custom options

### Git

- **Pager**: [Delta](https://github.com/dandavison/delta) - Syntax-highlighted diffs
- **Features**:
  - GPG signing enabled
  - Conditional includes for different organizations
  - GitHub CLI credential helpers
  - Verbose commits
  - Rebase by default for pulls

### Utilities

Enhanced replacements for common commands:
- `ls` → `lsd` (modern ls with icons and colors)
- `cd` → `zoxide` (smart directory jumping)

## Bin Scripts

Collection of utility scripts in `bin/` including:

- **Claude Code helpers**: claude-man, claude-notify, claude-resume, claude-watcher
- **GitHub CLI extensions**: gh-pm, gh-reruns, gh-reviews-by-user, gh-labeler, ghb
- **Tmux utilities**: toggle_notes_pane, monitor_tmux_pane, notes
- **Development tools**: refresh_safari, colors, true-colors, utcdate
- **Pi**: pi-bundle (faster startup), pi-launch, pi-ext-check (typecheck + test extensions)
- **Throwaway macOS VMs**: `vm` (see below)

## Throwaway macOS VMs

`bin/vm` wraps [tart](https://tart.run/) to give you disposable macOS guests on
Apple Silicon — useful for testing this bootstrap against a genuinely clean
machine.

```sh
brew install cirruslabs/cli/tart

vm new              # clone a fresh VM named "clean"
vm up               # boot it in a GUI window (-d to detach)
vm ssh              # shell in as admin, no password
vm reset            # wipe it and re-clone — back to pristine, ~3 seconds
vm bootstrap        # clone these dotfiles into it and run `mise bootstrap`
vm ls / vm ip / vm down / vm rm / vm seed
```

`vm bootstrap` is the point of the whole thing: it installs mise, clones this
repo and converges it, so a cold run proves the bootstrap works on a machine
that has never seen it. `--fresh` resets the VM first, `--ref <branch>` picks
the branch, and anything after `--` is passed through to `mise bootstrap`:

```sh
vm bootstrap --fresh --ref my-branch   # cold run, ~4 minutes
vm bootstrap -- --only dotfiles        # just the symlinks
```

It clones from **origin**, not your working tree, so uncommitted work is
invisible to it — push the branch first. `--force-dotfiles` is the default
here, because the base image ships its own `~/.gitconfig` and `~/.zprofile`
and the all-or-nothing dotfiles step would otherwise abort every run.

Every command takes an optional VM name, so `vm new sandbox && vm up sandbox`
runs a second one alongside. Defaults come from `VM_CPU`, `VM_MEM`, `VM_DISK`,
`VM_NAME`, `VM_DISPLAY`, `VM_SSH_KEY`, `VM_BASE_OCI`, `VM_REPO_URL`, and
`VM_REPO_PATH`.

Two golden images sit behind this and are never booted for day-to-day work.
`sequoia-base` is the pulled upstream image; `sequoia-base-keyed` is a clone of
it with your public key appended to `authorized_keys`, built once by `vm seed`.
`new` and `reset` clone from the keyed image, which is why a reset VM is both
instant and still passwordless — pushing a key per-VM would mean re-injecting it
after every reset. Re-run `vm seed` after changing `VM_SSH_KEY`.

Clones are APFS copy-on-write, so a 28GB VM costs almost no disk until it
diverges. Treat these as disposable rather than something to repair.

Worth knowing, both imposed by Apple's Virtualization.framework: at most **two**
macOS guests may run at once, and guests **cannot sign in to iCloud or the App
Store**. Anything needing an Apple ID has to be tested on real hardware.

## Keybindings

### Zsh
- `Esc`: Enter vi command mode
- `Ctrl-Y`: Copy current command to clipboard
- `Ctrl-R`: Fuzzy search command history
- `Ctrl-Alt-L`: Clear screen (zsh built-in; prompt only — see `Ctrl-Shift-L` for
  anything else)

### Tmux
- `Ctrl-h/j/k/l`: Navigate between vim and tmux panes
- `Ctrl-Shift-L`: Clear screen and scrollback
- `Alt-h/l`: Previous/next window
- `Alt-j/k`: Previous/next session

## Directory Structure

```
.
├── .config/nvim/        # Neovim configuration
├── .zsh/                # Zsh configuration modules
│   ├── abbreviations.zsh
│   ├── keybindings.zsh
│   ├── history.zsh
│   └── fzf.zsh
├── bin/                 # Utility scripts
├── .gitconfig           # Git configuration
├── .tmux.conf           # Tmux configuration
├── .zshrc               # Zsh initialization
└── mise.toml            # Declarative machine setup (`mise bootstrap`)
```

## License

MIT
