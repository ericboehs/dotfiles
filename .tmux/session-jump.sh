#!/usr/bin/env bash
# Jump to an adjacent session, optionally taking the current window along.
#
# Usage: session-jump.sh CURRENT_SESSION next|prev [move]
#
# tmux's own switch-client -n/-p walks sessions in name order, which would
# disagree with Prefix+s and the Ctrl-Shift-1..9 bindings. Both of those order
# by creation time, so do the same here.

set -euo pipefail

current=$1
direction=$2
mode=${3:-switch}

sessions=()
while IFS= read -r s; do sessions+=("$s"); done < <(
  tmux list-sessions -F '#{session_created}:#{session_name}' | sort -n | cut -d: -f2-
)

count=${#sessions[@]}
[ "$count" -lt 2 ] && exit 0

position=0
for n in "${!sessions[@]}"; do
  if [ "${sessions[$n]}" = "$current" ]; then
    position=$n
    break
  fi
done

if [ "$direction" = prev ]; then
  target=${sessions[$(((position - 1 + count) % count))]}
else
  target=${sessions[$(((position + 1) % count))]}
fi

if [ "$mode" != move ]; then
  tmux switch-client -t "$target"
  exit 0
fi

# Moving the last window out of a session destroys it, which is a lot to do on
# one keystroke, so refuse instead.
if [ "$(tmux display-message -p -t "$current" '#{session_windows}')" -lt 2 ]; then
  tmux display-message "Not moved: $current has only one window"
  exit 0
fi

# Window ids survive the move, so they are the reliable way to follow it.
window=$(tmux display-message -p -t "$current" '#{window_id}')

tmux move-window -s "$window" -t "$target:"
# renumber-windows does not fire on a move, so the source is left with a gap.
tmux move-window -r -t "$current"
tmux switch-client -t "$target"
tmux select-window -t "$window"
