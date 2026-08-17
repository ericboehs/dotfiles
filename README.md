# dotfiles

Personal dotfiles optimized for macOS and zsh. Features modern shell tools, comprehensive git configuration, and a customized development environment.

## Installation

```sh
bash -c "$(curl -sL https://raw.github.com/ericboehs/dotfiles/master/bootstrap.sh)"
```

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

### Version Management

- **Tool**: [mise](https://mise.jdx.dev/) (replaces asdf)
- Manages Node.js, Ruby, Python, and other language runtimes

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
vm ls / vm ip / vm down / vm rm / vm seed
```

Every command takes an optional VM name, so `vm new sandbox && vm up sandbox`
runs a second one alongside. Defaults come from `VM_CPU`, `VM_MEM`, `VM_DISK`,
`VM_NAME`, `VM_DISPLAY`, `VM_SSH_KEY`, and `VM_BASE_OCI`.

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
└── bootstrap.sh         # Installation script
```

## License

MIT
