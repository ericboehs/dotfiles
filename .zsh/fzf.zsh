# Setup fzf
# ---------
if [[ ! "$PATH" =~ "$HOME/.fzf/bin" ]]; then
  export PATH="$PATH:$HOME/.fzf/bin"
fi
export FZF_DEFAULT_COMMAND='ag -l --hidden --ignore .git -g ""'

# Man path
# --------
if [[ ! "$MANPATH" =~ "$HOME/.fzf/man" && -d "$HOME/.fzf/man" ]]; then
  export MANPATH="$MANPATH:$HOME/.fzf/man"
fi

# Auto-completion
# ---------------
[[ $- =~ i ]] && source "$HOME/.fzf/shell/completion.zsh" 2> /dev/null

# Key bindings
# ------------
source "$HOME/.fzf/shell/key-bindings.zsh"

