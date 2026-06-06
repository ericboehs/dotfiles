# mise: use shims instead of `mise activate`
export PATH="$HOME/.local/share/mise/shims:$PATH"

[[ $- == *i* ]] && [ -z "$DISABLE_ZOXIDE" ] && eval "$(zoxide init --cmd cd zsh)"

if command -v fnox >/dev/null 2>&1; then
  export FNOX_SHELL_OUTPUT=none
  eval "$(fnox activate zsh --if-missing ignore)"
  _fnox_hook        # run once at startup for current dir
  precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )
fi
