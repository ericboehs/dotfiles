# mise shims (instead of `mise activate`) are prepended in .zshenv, so that
# non-interactive shells get them too.

# zoxide setup
if [[ $- == *i* ]] && [ -z "$DISABLE_ZOXIDE" ]; then
  eval "$(zoxide init --cmd cd zsh)"

  # Keep every ~/Code repo jumpable, even ones never visited in a shell.
  # Runs detached, at most once a week; seeded entries score 1 so real
  # usage always outranks them. stdin closed so a slow seed cannot eat a
  # paste that landed while the prompt was still coming up.
  zoxide-seed --if-stale 7 </dev/null >/dev/null 2>&1 &!
fi

# fnox setup
if command -v fnox >/dev/null 2>&1; then
  export FNOX_SHELL_OUTPUT=none
  # activate registers _fnox_hook on precmd + chpwd. precmd is too hot (every
  # prompt), so drop it. chpwd stays: a cd into ~/Workspaces has to pick up
  # that tree's fnox.toml (CLOUDFLARE_ACCOUNT_ID). Startup still needs one
  # hook-env for global ~/.config/fnox/config.toml (COPILOT_TOKEN etc.).
  eval "$(fnox activate zsh --if-missing ignore)"
  precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )

  # hook-env walks ~40 keychain items and prints a ~3KB __FNOX_SESSION line.
  # Running it synchronously at first idle (sched +0 _fnox_hook) froze the
  # new prompt for 80–330ms: syntax highlighting wasn't up yet, and a paste
  # during that window showed raw bracketed-paste `200~` / a chunk of the
  # session blob, then vanished on redraw. Same pattern as _bg_git_fetch:
  # start the work in the background, apply the env when the fd goes ready.
  _fnox_hook_done() {
    zle -F $1
    local out
    out=$(<&$1)
    exec {1}<&-
    ((_fnox_hook_fd == $1)) && typeset -gi _fnox_hook_fd=0
    [[ -n $out ]] && eval "$out"
  }
  _fnox_hook() {
    local fd out
    if (( ${+_fnox_hook_fd} && _fnox_hook_fd )); then
      zle -F $_fnox_hook_fd 2>/dev/null
      exec {_fnox_hook_fd}<&- 2>/dev/null
      typeset -gi _fnox_hook_fd=0
    fi
    exec {fd}< <(command fnox hook-env -s zsh --if-missing ignore </dev/null 2>/dev/null)
    typeset -gi _fnox_hook_fd=$fd
    # sched +0 / chpwd have zle. If they don't (tests, zsh -c), apply sync
    # so COPILOT_TOKEN still lands rather than sitting in a pipe forever.
    if ! zle -F $fd _fnox_hook_done 2>/dev/null; then
      out=$(<&$fd)
      exec {fd}<&-
      typeset -gi _fnox_hook_fd=0
      [[ -n $out ]] && eval "$out"
    fi
  }
  (( $+functions[_fnox_hook] )) && sched +0 _fnox_hook
fi
