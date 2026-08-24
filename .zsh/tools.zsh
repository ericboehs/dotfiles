# mise: use shims instead of `mise activate`
export PATH="$HOME/.local/share/mise/shims:$PATH"

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
  eval "$(fnox activate zsh --if-missing ignore)"
  _fnox_hook        # run once at startup for current dir
  precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )
fi
