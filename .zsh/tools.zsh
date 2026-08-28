# mise shims (instead of `mise activate`) are prepended in .zshenv, so that
# non-interactive shells get them too.

# zoxide setup
if [[ $- == *i* ]] && [ -z "$DISABLE_ZOXIDE" ]; then
  eval "$(zoxide init --cmd cd zsh)"

  # Keep every ~/Code repo jumpable, even ones never visited in a shell.
  # Runs detached, at most once a week; seeded entries score 1 so real
  # usage always outranks them.
  (zoxide-seed --if-stale 7 &) >/dev/null 2>&1
fi

# fnox setup
if command -v fnox >/dev/null 2>&1; then
  export FNOX_SHELL_OUTPUT=none
  # activate's hook-env loads global ~/.config/fnox/config.toml (needed for
  # COPILOT_TOKEN etc.). _fnox_hook then merges the current directory's
  # fnox.toml (CLOUDFLARE_ACCOUNT_ID under ~/Workspaces, etc.).
  # Defer only the extra hook: `sched 0` is Dec 31; `sched +0` is next idle.
  eval "$(fnox activate zsh --if-missing ignore)"
  precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )
  (( $+functions[_fnox_hook] )) && sched +0 _fnox_hook
fi
