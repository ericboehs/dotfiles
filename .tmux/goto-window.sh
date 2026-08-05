#!/usr/bin/env bash
# Find-or-create a window by name in SESSION, then select it.
#
# Usage: goto-window.sh SESSION NAME COMMAND...
#
# Targeting with "-t =name" looks like the obvious way to do this, but it
# errors out with "can't find window" whenever two windows happen to share the
# name, so resolve to the first matching index instead.

set -euo pipefail

session=$1
name=$2
shift 2

index=$(tmux list-windows -t "$session" -F '#{window_index} #{window_name}' |
  awk -v n="$name" '$2 == n { print $1; exit }')

if [ -n "$index" ]; then
  tmux select-window -t "$session:$index"
else
  tmux new-window -t "$session:" -n "$name" "$@"
fi
