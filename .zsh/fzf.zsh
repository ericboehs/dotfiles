# Check out https://minsw.github.io/fzf-color-picker/
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Allow regex search like ^git to find history starting with git
export FZF_CTRL_R_OPTS="--no-sort --exact --preview 'echo {}' --preview-window down:3:wrap"

# Catppuccin colors, picked per macOS appearance on each prompt
_fzf_theme_sync() {
  if defaults read -g AppleInterfaceStyle 2>/dev/null | grep -q Dark; then
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
_fzf_theme_sync
autoload -Uz add-zsh-hook
add-zsh-hook precmd _fzf_theme_sync
