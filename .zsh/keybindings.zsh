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
