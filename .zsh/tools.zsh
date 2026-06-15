# mise: use shims instead of `mise activate`
export PATH="$HOME/.local/share/mise/shims:$PATH"

# zoxide setup
[[ $- == *i* ]] && [ -z "$DISABLE_ZOXIDE" ] && eval "$(zoxide init --cmd cd zsh)"

# fnox setup
if command -v fnox >/dev/null 2>&1; then
  export FNOX_SHELL_OUTPUT=none
  eval "$(fnox activate zsh --if-missing ignore)"
  _fnox_hook        # run once at startup for current dir
  precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )
fi

# forge setup (suppress stderr: forge writes config errors to stderr, which
# leaks past `eval` onto the console and trips p10k's instant-prompt warning)
[[ -z "$_FORGE_PLUGIN_LOADED" ]] && eval "$(forge zsh plugin 2>/dev/null)"
[[ -z "$_FORGE_THEME_LOADED" ]] && eval "$(forge zsh theme 2>/dev/null)"

# forge: Have to rebind or zsh-autosuggestion doesn't clear the suggestion after pressing enter
bindkey "^M" magic-abbrev-expand-and-execute
