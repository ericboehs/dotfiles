#!/usr/bin/env bash
# Move the current window one position left or right, wrapping at the ends.
#
# Usage: move-window.sh SESSION left|right
#
# tmux's own relative targets (swap-window -t - / -t +) resolve against the
# *current* session, which is whatever session happens to be attached, and they
# do not wrap. Resolving positions from the window list keeps this predictable
# and lets Ctrl-Shift-h/Ctrl-Shift-l always do something.
#
# swap-window -d keeps the focus on the window that moved rather than jumping
# to whatever it traded places with.

set -euo pipefail

session=$1
direction=$2

# Positions in list order, which is not the same as index order once windows
# have been killed and renumber-windows has left gaps.
indexes=()
while IFS= read -r i; do indexes+=("$i"); done < <(
  tmux list-windows -t "$session" -F '#{window_index}'
)

current=$(tmux display-message -p -t "$session" '#{window_index}')

position=0
for n in "${!indexes[@]}"; do
  if [ "${indexes[$n]}" = "$current" ]; then
    position=$n
    break
  fi
done

count=${#indexes[@]}
[ "$count" -lt 2 ] && exit 0

if [ "$direction" = left ]; then
  target=$(((position - 1 + count) % count))
else
  target=$(((position + 1) % count))
fi

tmux swap-window -d -s "$session:$current" -t "$session:${indexes[$target]}"
