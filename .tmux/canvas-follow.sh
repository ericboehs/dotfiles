#!/bin/sh
# tmux hook: tell the pi canvas daemon which pane you moved to, so canvas tabs
# in follow mode (the "Follow tmux" button) open that pi session's page.
#
#   canvas-follow.sh <pane id> <socket path>
#
# Panes that aren't running pi are ignored by the daemon. Quiet, and done in
# a second at most, when the daemon isn't running.
pane=$1
socket=$2
case $pane in %[0-9]*) ;; *) exit 0 ;; esac
case $socket in /*) ;; *) socket= ;; esac
curl -s -m 1 -o /dev/null -X POST -H 'X-Canvas: 1' -H 'Content-Type: application/json' \
  -d "{\"pane\":\"$pane\",\"socket\":\"$socket\"}" \
  "http://127.0.0.1:${PI_CANVAS_PORT:-8790}/follow" 2>/dev/null
exit 0
