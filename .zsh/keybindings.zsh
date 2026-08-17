# Explicitly set emacs mode (needed for tmux)
bindkey -e

# Esc to drop into vi command mode (Ctrl-X, Ctrl-V also goes to normal mode)
bindkey -M emacs '\e' vi-cmd-mode
export KEYTIMEOUT=10 # Escape takes too long
bindkey -r '^[h' # Disables Alt+H for help as it interferes with Escape, h (motion)

# Clear screen is Ctrl-Shift-L, bound in .tmux.conf — tmux eats Alt-L (next-window)
# and Ctrl-L (vim-tmux-navigator) before either reaches zsh.

# Open editor when pressing `v` in normal mode
autoload edit-command-line; zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# Delete words delimited by / or =
export WORDCHARS=${WORDCHARS//[\/=]}

# Copy current command to clipboard
function copy-current-command-to-clipboard {
  print -rn -- "$BUFFER" | pbcopy        # $BUFFER = command-line you’re editing
  zle -M "Copied current command to clipboard"
}
zle -N copy-current-command-to-clipboard
bindkey '^Y' copy-current-command-to-clipboard   # <Ctrl-Y>, pick any key you like
