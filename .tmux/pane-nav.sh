#!/usr/bin/env bash
# Move between panes, and keep going when there is no pane that way.
#
# Usage: pane-nav.sh h|j|k|l [pane-id]
#
# h/l fall out of the window and into the previous/next window; j/k fall out of
# the session and into the previous/next session, in the same creation-time
# order as session-jump.sh and Ctrl-Shift-1..9.
#
# Bound to Ctrl-h/j/k/l in tmux.conf, and called by the same keys in nvim once
# nvim has run out of splits, so a split edge and a pane edge behave the same.
# nvim needs the script because nvim-tmux-navigation shells out to `select-pane`
# directly and so never reaches the tmux key binding.

set -euo pipefail

# run-shell exports TMUX but *not* TMUX_PANE, so the tmux bindings pass the pane
# in as the second argument, expanded from #{pane_id}. nvim calls this as a
# plain process inside the pane, where TMUX_PANE is already in the environment.
# Everything is resolved against that pane rather than against the "current"
# pane so the two callers cannot disagree.
# session_name is read last so that a name containing spaces survives the split.
pane=${2-${TMUX_PANE-}}

case ${1-} in
  h) edge=pane_at_left;   move=-L ;;
  j) edge=pane_at_bottom; move=-D ;;
  k) edge=pane_at_top;    move=-U ;;
  l) edge=pane_at_right;  move=-R ;;
  *) echo "usage: ${0##*/} h|j|k|l [pane-id]" >&2; exit 2 ;;
esac

if [ -z "$pane" ]; then
  echo "${0##*/}: no pane id given and TMUX_PANE is unset" >&2
  exit 2
fi

# selection_present is written as a conditional because it expands to the empty
# string outside copy mode, which would shift every field after it.
read -r at_edge zoomed floating selecting windows session < <(
  tmux display-message -p -t "$pane" \
    "#{$edge} #{window_zoomed_flag} #{pane_floating_flag} #{?selection_present,1,0} #{session_windows} #{session_name}"
)

# A floating pane (floax popup) is not part of the window layout at all, so hand
# it to tmux and let it do whatever it does.
if [ "$floating" = 1 ]; then
  exec tmux select-pane -t "$pane" "$move"
fi

# A zoomed pane covers its window, and while it does, tmux answers every
# pane_at_* flag with 1 and resolves the direction tokens by wrapping round to
# whichever pane is left, so there is no way to ask whether a real neighbour
# lies that way. Drop the zoom, which restores the true layout, and ask again.
# If a pane genuinely is that way, move to it and stay unzoomed — that is what
# pressing the key is asking for. If nothing is, put the zoom back before
# leaving, so the window is untouched when it is next returned to.
#
# The exception is a selection in progress. Any select-pane against a zoomed
# pane throws the selection away, even one that finds no pane and does nothing,
# and the unzoom is a resize, which throws it away too. Leaving the window is
# the only move that keeps it: next-window, previous-window and switch-client
# all leave the selection, the mode and the zoom exactly as they were. So a
# selection skips this block entirely and falls through below, which treats the
# zoom as a window holding a single pane.
if [ "$zoomed" = 1 ] && [ "$selecting" = 0 ]; then
  tmux resize-pane -Z -t "$pane"
  at_edge=$(tmux display-message -p -t "$pane" "#{$edge}")
  if [ "$at_edge" = 0 ]; then
    exec tmux select-pane -t "$pane" "$move"
  fi
  tmux resize-pane -Z -t "$pane"
fi

if [ "$at_edge" = 0 ]; then
  exec tmux select-pane -t "$pane" "$move"
fi

case $1 in
  h | l)
    # previous-window and next-window fail with "no previous window" when the
    # session holds a single window, and tmux reports a failed run-shell as
    # "'...' returned 1" in the status line. There is nowhere to go, so stop
    # quietly instead. A floax popup is exactly this case: it runs a session of
    # its own, created with one window.
    if [ "$windows" -lt 2 ]; then
      exit 0
    fi
    if [ "$1" = h ]; then
      exec tmux previous-window -t "$session"
    else
      exec tmux next-window -t "$session"
    fi
    ;;
  j | k)
    # A floax popup is a client of its own attached to the scratch session, so a
    # session jump from inside it would swap what the popup is showing rather
    # than move the terminal anywhere. Treat the popup as self-contained.
    if [ "$session" = "$(tmux show-environment -g FLOAX_SESSION_NAME 2>/dev/null | cut -d= -f2-)" ]; then
      exit 0
    fi
    if [ "$1" = j ]; then
      exec "$(dirname "$0")/session-jump.sh" "$session" next
    else
      exec "$(dirname "$0")/session-jump.sh" "$session" prev
    fi
    ;;
esac
