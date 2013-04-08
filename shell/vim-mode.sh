# Allow editing of the text on the current command line with v (cmd mode)
autoload -U edit-command-line
zle -N edit-command-line
bindkey -M vicmd v edit-command-line

# Map hh to vim-cmd-mode
bindkey -M viins 'hhh' vi-cmd-mode
# Map jj to vim-cmd-mode
bindkey -M viins 'jj' vi-cmd-mode
# Map kk to vim-cmd-mode
bindkey -M viins 'kkk' vi-cmd-mode
# Map ll to vim-cmd-mode
bindkey -M viins 'lll' vi-cmd-mode
