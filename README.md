# dotfiles

Personal dotfiles optimized for macOS and zsh. Features modern shell tools, comprehensive git configuration, and a customized development environment.

## Installation

```sh
curl -fsSL https://mise.run | sh
git clone https://github.com/ericboehs/dotfiles ~/Code/github.com/ericboehs/dotfiles
cd ~/Code/github.com/ericboehs/dotfiles && mise trust && mise bootstrap
```

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

## Keybindings

### Zsh
- `Esc`: Enter vi command mode
- `Alt-L`: Clear screen
- `Ctrl-Y`: Copy current command to clipboard
- `Ctrl-R`: Fuzzy search command history

### Tmux
- `Ctrl-h/j/k/l`: Navigate between vim and tmux panes

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
