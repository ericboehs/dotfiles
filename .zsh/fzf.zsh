# Check out https://minsw.github.io/fzf-color-picker/
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Allow regex search like ^git to find history starting with git
export FZF_CTRL_R_OPTS="--no-sort --exact --preview 'echo {}' --preview-window down:3:wrap"

# Catppuccin colors, picked per macOS appearance.
# Reads ~/.cache/dark-mode flag (updated in background) to avoid
# forking `defaults` synchronously. Run `_fzf_theme_sync` after
# toggling dark/light mode if the flag is stale.
_fzf_theme_sync() {
  local mode
  if [[ -f ~/.cache/dark-mode ]]; then
    mode="$(< ~/.cache/dark-mode)"
  else
    mode=light
  fi
  if [[ "$mode" == dark ]]; then
    # Mocha
    export FZF_DEFAULT_OPTS="\
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8"
  else
    # Latte
    export FZF_DEFAULT_OPTS="\
--color=bg+:#ccd0da,bg:#eff1f5,spinner:#dc8a78,hl:#d20f39 \
--color=fg:#4c4f69,header:#d20f39,info:#8839ef,pointer:#dc8a78 \
--color=marker:#7287fd,fg+:#4c4f69,prompt:#8839ef,hl+:#d20f39"
  fi
}

# Update the flag in background (no shell startup cost)
{ defaults read -g AppleInterfaceStyle &>/dev/null && echo dark || echo light } > ~/.cache/dark-mode &!

_fzf_theme_sync
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _fzf_theme_sync
