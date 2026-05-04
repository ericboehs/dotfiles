#!/usr/bin/env bash
# bootstrap.sh — install Eric's dotfiles, package deps, fonts, plugins.
#
# Usage:
#   ./bootstrap.sh                 # full install
#   ./bootstrap.sh --dry-run       # preview without changes
#
# Skip individual steps by setting any of these env vars to a non-empty value:
#   SKIP_DEPS      — brew/apt package install
#   SKIP_FONTS     — Inconsolata Nerd Font (macOS only)
#   SKIP_ITERM     — Catppuccin Mocha import (macOS only)
#   SKIP_DEFAULTS  — defaults.sh (macOS only)
#   SKIP_LINK      — symlink dotfiles into $HOME
#   SKIP_MISE      — mise trust on the symlinked config
#   SKIP_TPM       — tmux plugin manager + plugin install
#
# FORCE_OVERWRITE=1 auto-yes on existing-file overwrite prompts.

set -eo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
skip() { printf "\033[1;33m--\033[0m %s (skipped)\n" "$*"; }

# Run a command, or print it under --dry-run. Caller passes args individually
# (no shell metacharacters); use explicit `$DRY_RUN || cmd` for pipes/globs.
run() {
  if $DRY_RUN; then printf "    \033[2;37m[dry] %s\033[0m\n" "$*"
  else "$@"
  fi
}

resolve_dotfiles_dir() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  if [[ -d "$d/.git" ]]; then
    echo "$d"; return
  fi
  d="$HOME/Code/github.com/ericboehs/dotfiles"
  mkdir -p "$(dirname "$d")"
  [[ -e "$d" ]] || git clone https://github.com/ericboehs/dotfiles "$d"
  echo "$d"
}

install_deps() {
  [[ -n "${SKIP_DEPS:-}" ]] && { skip "package deps"; return; }
  if [[ "$OSTYPE" == darwin* ]]; then
    log "Installing Homebrew dependencies"
    run brew install mise neovim git direnv lsd starship zoxide fzf \
      zsh-autosuggestions gpg tmux ripgrep fd lua gh terminal-notifier delta
  elif [[ "$OSTYPE" == linux-gnu* ]]; then
    log "Installing apt dependencies"
    run sudo apt-get update -qq
    run sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      zsh neovim direnv lsd starship zoxide fzf zsh-autosuggestions \
      gnupg tmux ripgrep fd-find bat lua5.4 gh git-delta
    if ! command -v mise >/dev/null; then
      log "Installing mise"
      $DRY_RUN && printf "    \033[2;37m[dry] curl -fsSL https://mise.run | sh\033[0m\n"
      $DRY_RUN || curl -fsSL https://mise.run | sh
    fi
    log "Linking ~/.local/bin shims for fd/bat (Debian ships fdfind/batcat)"
    run mkdir -p "$HOME/.local/bin"
    [[ -x /usr/bin/fdfind ]] && run ln -sf /usr/bin/fdfind "$HOME/.local/bin/fd"
    [[ -x /usr/bin/batcat ]] && run ln -sf /usr/bin/batcat "$HOME/.local/bin/bat"
    if [[ "$SHELL" != "$(command -v zsh)" ]]; then
      log "Setting zsh as default shell"
      run sudo chsh -s "$(command -v zsh)" "$USER"
    fi
  fi
}

install_fonts() {
  [[ "$OSTYPE" != darwin* ]] && return
  [[ -n "${SKIP_FONTS:-}" ]] && { skip "fonts"; return; }
  if [[ -f ~/Library/Fonts/InconsolataNerdFontMono-Regular.ttf ]]; then
    skip "Inconsolata Nerd Font (already installed)"; return
  fi
  log "Installing Inconsolata Nerd Font"
  local tmp; tmp=$(mktemp -d)
  run curl -fsSL -o "$tmp/Inconsolata.zip" \
    https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Inconsolata.zip
  run unzip -q "$tmp/Inconsolata.zip" -d "$tmp"
  run mkdir -p ~/Library/Fonts
  $DRY_RUN && printf "    \033[2;37m[dry] cp %s/*.ttf ~/Library/Fonts/\033[0m\n" "$tmp"
  $DRY_RUN || cp "$tmp"/*.ttf ~/Library/Fonts/ 2>/dev/null || true
  run rm -rf "$tmp"
}

import_iterm_theme() {
  [[ "$OSTYPE" != darwin* ]] && return
  [[ -n "${SKIP_ITERM:-}" ]] && { skip "iTerm2 theme"; return; }
  if plutil -extract 'Custom Color Presets.Catppuccin Mocha' xml1 -o - \
       ~/Library/Preferences/com.googlecode.iterm2.plist >/dev/null 2>&1; then
    skip "Catppuccin Mocha (already imported)"; return
  fi
  log "Importing Catppuccin Mocha for iTerm2"
  local tmp; tmp=$(mktemp -d)
  run curl -fsSL -o "$tmp/Catppuccin Mocha.itermcolors" \
    "https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/schemes/Catppuccin%20Mocha.itermcolors"
  run open "$tmp/Catppuccin Mocha.itermcolors"
  run sleep 2
  run rm -rf "$tmp"
}

apply_macos_defaults() {
  [[ "$OSTYPE" != darwin* ]] && return
  [[ -n "${SKIP_DEFAULTS:-}" ]] && { skip "macOS defaults"; return; }
  [[ ! -x "$DOTFILES_DIR/defaults.sh" ]] && return
  log "Applying macOS defaults"
  if $DRY_RUN; then
    printf "    \033[2;37m[dry] %s/defaults.sh\033[0m\n" "$DOTFILES_DIR"
  else
    "$DOTFILES_DIR/defaults.sh"
  fi
}

link_dotfiles() {
  [[ -n "${SKIP_LINK:-}" ]] && { skip "symlinks"; return; }
  log "Linking dotfiles into \$HOME"
  pushd "$DOTFILES_DIR" > /dev/null

  # Iterate only tracked top-level dotfiles (avoids picking up .DS_Store,
  # .claude/, .ruby-lsp/, .zshrc.local, etc. that are gitignored locally).
  local files f source_file target_file
  files="$(git ls-files -z | tr '\0' '\n' | awk -F/ '/^\./ {print $1}' | sort -u) .ssh/config"
  for f in $files; do
    case "$f" in
      .|..|.git|.gitignore|.gitmodules|.config|.ssh|bootstrap.sh|defaults.sh|README.md|.github|.tmux)
        continue ;;
    esac
    source_file="$DOTFILES_DIR/$f"
    target_file="$HOME/$(dirname "$f")/$(basename "$f")"

    case "$f" in
      .gitconfig.private.example)
        [[ "$USER" == "ericboehs" ]] && run ln -fs "$source_file" ~/.gitconfig.private
        continue ;;
      .gitconfig.va-ghe.example)
        [[ "$USER" == "ericboehs" ]] && run ln -fs "$source_file" ~/.gitconfig.va-ghe
        continue ;;
      .gitignore.global)
        run ln -fs "$source_file" ~/.gitignore
        continue ;;
    esac

    if [[ -e "$HOME/$f" ]]; then
      [[ "$(readlink "$HOME/$f")" == "$DOTFILES_DIR/$f" ]] && continue
      if [[ -z "${FORCE_OVERWRITE:-}" ]] && ! $DRY_RUN; then
        read -r -p "\$HOME/$f exists. Overwrite? [Yn] " yn
        case "$yn" in [Nn]*) continue ;; esac
      fi
      run ln -fs "$source_file" "$HOME/"
    else
      run ln -fs "$source_file" "$target_file"
    fi
  done

  run mkdir -p ~/.config
  log "Linking nvim config"
  run ln -fns "$DOTFILES_DIR/.config/nvim" ~/.config/nvim
  log "Linking mise config"
  run mkdir -p ~/.config/mise
  run ln -fs "$DOTFILES_DIR/.config/mise/config.toml" ~/.config/mise/config.toml

  # ~/.tmux/ is shared with TPM (~/.tmux/plugins/), so we link individual
  # helper scripts rather than the whole directory.
  run mkdir -p ~/.tmux
  log "Linking tmux helpers"
  run ln -fs "$DOTFILES_DIR/.tmux/loadavg.sh" ~/.tmux/loadavg.sh

  popd > /dev/null
}

trust_mise_config() {
  [[ -n "${SKIP_MISE:-}" ]] && { skip "mise trust"; return; }
  local mise_bin
  mise_bin="$(command -v mise || true)"
  [[ -z "$mise_bin" && -x "$HOME/.local/bin/mise" ]] && mise_bin="$HOME/.local/bin/mise"
  [[ ! -x "$mise_bin" ]] && return
  log "Trusting mise config"
  run "$mise_bin" trust ~/.config/mise/config.toml
}

install_tpm() {
  [[ -n "${SKIP_TPM:-}" ]] && { skip "TPM"; return; }
  if [[ -d ~/.tmux/plugins/tpm ]]; then
    skip "TPM (already installed)"; return
  fi
  log "Installing TPM and plugins"
  run git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
  run ~/.tmux/plugins/tpm/bin/install_plugins
}

# ---- main ----
DOTFILES_DIR="$(resolve_dotfiles_dir)"
$DRY_RUN && log "DRY RUN — no changes will be made"
log "Dotfiles dir: $DOTFILES_DIR"
mkdir -p ~/.ssh

pushd "$DOTFILES_DIR" > /dev/null
run git submodule init
run git submodule update
popd > /dev/null

install_deps
install_fonts
import_iterm_theme
link_dotfiles
trust_mise_config
apply_macos_defaults
install_tpm

log "All done. Enjoy your shell."
