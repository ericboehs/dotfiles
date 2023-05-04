# Explicitly set emacs mode (needed for tmux)
bindkey -e

# Open vim when pressing `v` in normal mode (Press Ctrl-X, Ctrl-V to temporarily enter vi's normal mode)
autoload edit-command-line; zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# Bind the Esc key to clear the screen
bindkey '\e' clear-screen
