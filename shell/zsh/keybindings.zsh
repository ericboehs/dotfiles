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

# Set directions and delete keys
bindkey '^[^[[D' vi-backward-word
bindkey '^[^[[C' vi-forward-word
bindkey '^[[5D' beginning-of-line
bindkey '^[[5C' end-of-line

# make the delete key (or Fn + Delete on the Mac) work instead of outputting a ~
bindkey '^?' backward-delete-char 
bindkey '^[[3~' delete-char
bindkey '^[3;5~' delete-char
bindkey '\e[3~' delete-char

bindkey '^[^N' newtab

# Use incremental search
bindkey "^R" history-incremental-search-backward

# Remap Ctrl-S to Ctrl-- for stopping termianl output
stty stop 
