# Check out https://minsw.github.io/fzf-color-picker/
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Allow regex search like ^git to find history starting with git
export FZF_CTRL_R_OPTS="--no-sort --exact --preview 'echo {}' --preview-window down:3:wrap"

# Catppuccin colors, picked per appearance. The palettes themselves live in
# fzf-colors.{dark,light} beside this file, because .tmux/theme-sync.sh needs
# the same strings for tmux popups and a second copy drifted from this one.
# Mode comes from the ~/.cache/dark-mode flag appearance.zsh (sourced ahead of
# this file) writes, which keeps one answer for fzf, tmux and btop and is the
# only one a Linux box can get. Run `_fzf_theme_sync` after toggling dark/light
# mode if the flag is stale.
#
# $(<file) is a zsh builtin read, not a fork, so this stays free at startup.
_fzf_theme_sync() {
  local mode=dark
  [[ -f ~/.cache/dark-mode ]] && mode="$(< ~/.cache/dark-mode)"
  [[ -f ~/.zsh/fzf-colors.$mode ]] || return
  export FZF_DEFAULT_OPTS="$(< ~/.zsh/fzf-colors.$mode)"
}

_fzf_theme_sync
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _fzf_theme_sync
