function zle-keymap-select zle-line-init
{
    # change cursor shape in iTerm2
    if [ -n "$TMUX" ]; then
      COMMAND_CURSOR="\EPtmux;\E\E]50;CursorShape=0\C-G\E\\"
      INSERT_CURSOR="\EPtmux;\E\E]50;CursorShape=1\C-G\E\\"
    else
      COMMAND_CURSOR="\E]50;CursorShape=0\C-G"
      INSERT_CURSOR="\E]50;CursorShape=1\C-G"
    fi

    case $KEYMAP in
        vicmd)      print -n -- $COMMAND_CURSOR;; # block cursor
        viins|main) print -n -- $INSERT_CURSOR;;  # line cursor
    esac

    zle reset-prompt
    zle -R
}

function zle-line-finish
{
    print -n -- "\E]50;CursorShape=0\C-G"  # block cursor
}

zle -N zle-line-init
zle -N zle-line-finish
zle -N zle-keymap-select
