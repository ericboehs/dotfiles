source "$HOME/.zsh/powerlevel10k/powerlevel10k.zsh-theme"
[[ -f "$HOME/.p10k.zsh" ]] && source "$HOME/.p10k.zsh"

# Background git fetch on cd -- triggers p10k VCS refresh when done
_bg_git_fetch_done() {
  zle -F $1       # unregister fd watcher
  exec {1}<&-     # close fd
  local dir=${PWD:a}
  # Purge p10k's cached gitstatus and re-query asynchronously;
  # when gitstatus responds, _p9k_vcs_resume re-renders + resets prompt
  _p9k__gitstatus_last[$dir]=""
  _p9k_git_slow[$dir]=""
  _p9k__git_dir=$GIT_DIR
  gitstatus_query_p9k_ -d $dir -t 0 -c '_p9k_vcs_resume 1' POWERLEVEL9K 2>/dev/null
}

_bg_git_fetch() {
  git rev-parse --is-inside-work-tree &>/dev/null || return
  local fd
  exec {fd}< <(git fetch --quiet 2>/dev/null)
  zle -F $fd _bg_git_fetch_done
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd _bg_git_fetch
