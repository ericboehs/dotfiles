# Allow Ctrl-S and Ctrl-Q to be keybindings in vim
stty -ixon > /dev/null 2>/dev/null

# Set directions and delete keys
bindkey '^[^[[D' vi-backward-word
bindkey '^[^[[C' vi-forward-word
bindkey '^[[5D' beginning-of-line
bindkey '^[[5C' end-of-line

# Make the delete key (or Fn + Delete on the Mac) work instead of outputting a ~
bindkey '^?' backward-delete-char
bindkey '^[[3~' delete-char
bindkey '^[3;5~' delete-char
bindkey '\e[3~' delete-char

# Make alt-delete and alt-fn-delete work
bindkey '^[^?' backward-kill-word
bindkey '^[(' kill-word # In iTerm you'll need to configure Alt-Fn-Delete to send this keycode

# Vipermode (Vi and Emacs keybindings). https://gist.github.com/burke/1689923
bindkey -v
bindkey "^B" backward-char
bindkey "^A" beginning-of-line
bindkey "^E" end-of-line
bindkey "^F" forward-char
bindkey "^X^F" vi-find-next-char
bindkey "^N" down-line-or-history
bindkey "^R" history-incremental-search-backward
bindkey "^S" history-incremental-search-forward
bindkey "^X^N" infer-next-history
bindkey "^P" up-line-or-history
bindkey "^H" backward-delete-char
bindkey "^W" backward-kill-word
bindkey "^X^J" vi-join
bindkey "^K" kill-line
bindkey "^X^K" kill-buffer
bindkey "^U" kill-whole-line
bindkey "^X^B" vi-match-bracket
bindkey "^X^O" overwrite-mode
bindkey "^V" quoted-insert
bindkey "^T" transpose-chars
bindkey "^Y" yank
bindkey "^D" delete-char-or-list
bindkey "^X*" expand-word
bindkey "^XG" list-expand
bindkey "^Xg " list-expand
bindkey "^M" accept-line
bindkey "^J" accept-line
bindkey "^O" accept-line-and-down-history
bindkey "^X^V" vi-cmd-mode
bindkey "^L" clear-screen
bindkey "^X^X" exchange-point-and-mark
bindkey "^Q" push-line
bindkey "^G" send-break
bindkey "^@" set-mark-command
bindkey "^Xu " undo
bindkey "^X^U" undo
bindkey "^_" undo
