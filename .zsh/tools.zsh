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
  # Two calls, not one redundant pair: `activate`'s own hook-env only resolves
  # the global ~/.config/fnox/config.toml, while _fnox_hook merges the
  # fnox.toml of the current directory on top. Dropping it silently loses
  # every project-scoped secret (verified: CLOUDFLARE_ACCOUNT_ID under
  # ~/Workspaces goes missing), so the ~0.33s it costs buys something.
  eval "$(fnox activate zsh --if-missing ignore)"
  _fnox_hook        # run once at startup for current dir
  precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )
fi
