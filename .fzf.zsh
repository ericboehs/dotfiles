# Setup fzf
# ---------
if [[ ! "$PATH" == */opt/homebrew/opt/fzf/bin* ]]; then
  export PATH="${PATH:+${PATH}:}/opt/homebrew/opt/fzf/bin"
fi

# Auto-completion + key bindings — try Homebrew (macOS) then Debian/Ubuntu paths.
for _fzf_base in \
  /opt/homebrew/opt/fzf/shell \
  /usr/share/doc/fzf/examples; do
  if [[ -r "$_fzf_base/key-bindings.zsh" ]]; then
    [[ $- == *i* ]] && source "$_fzf_base/completion.zsh" 2>/dev/null
    source "$_fzf_base/key-bindings.zsh"
    break
  fi
done
unset _fzf_base
