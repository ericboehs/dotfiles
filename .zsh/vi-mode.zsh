# Allow editing of the text on the current command line with v (cmd mode)
autoload -U edit-command-line
zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# Switch from emacs to vi mode
bindkey -v

# Map jk to vim-cmd-mode
bindkey -M viins 'jk' vi-cmd-mode

# Change cursor when in normal mode
function zle-line-init zle-keymap-select {
  PROMPT="%(?.%F{cyan}.%F{red})${${KEYMAP/vicmd/❯❯}/(main|viins)/ ❯}%f "
  zle reset-prompt
}

zle -N zle-line-init
zle -N zle-keymap-select
