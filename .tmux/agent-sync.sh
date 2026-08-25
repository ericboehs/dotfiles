#!/usr/bin/env bash
# Reconcile the agent-running flags against reality. Runs on every status
# refresh via #() in status-format[0], next to theme-sync.sh.
#
# The pi extension (~/.pi-agent/extensions/tmux-attention.ts) and Claude's
# hooks (claude-agent-state.sh) maintain the same convention while their turns
# run: per-pane @agent_running, plus a rolled-up window-level @agent_count that
# the status bar uses to dim #I on background windows. If an agent dies without
# clearing its flag — kill -9, crash, tmux resurrect — the window would stay
# dimmed forever. One ps snapshot answers for every pane at once: a flagged
# pane whose tty no longer hosts a claude/pi process has lost its agent.

# Cheap exit when nothing is flagged: list-panes is a few ms, and this runs
# every refresh. The ps snapshot below only happens for flagged panes.
panes=$(tmux list-panes -a -F '#{pane_id}|#{pane_tty}|#{@agent_running}')
grep -q '|on$' <<<"$panes" || exit 0

# Which ttys currently host an agent process? Word-split each line so the
# fields are exact regardless of padding: $1 = tty, $2 = argv[0], $3 = argv[1].
# Matched on the basename of argv[0]; pi also gets caught via "node .../bin/pi".
live=" "
while IFS= read -r line; do
  # shellcheck disable=SC2086  # intentional word split
  set -- $line
  [ $# -ge 2 ] || continue
  base=${2##*/}
  case $base in
    claude|pi)
      live="$live$1 " ;;
    node)
      [ "${3##*/}" = pi ] && live="$live$1 " ;;
  esac
done < <(ps -axo tty=,args=)

# Every stale flag gets cleared and its window recounted, so the dim drops as
# soon as the status line notices rather than never.
# NB: tmux's #{pane_tty} is /dev/ttysN while ps reports bare ttysN — normalize
# before comparing.
while IFS='|' read -r pane tty flag; do
  [ "$flag" = on ] || continue
  case "$live" in *" ${tty#/dev/} "* ) continue ;; esac
  tmux set-option -p -u -t "$pane" @agent_running

  win=$(tmux display-message -p -t "$pane" '#{window_id}')
  count=$(tmux list-panes -t "$win" -F '#{@agent_running}' | grep -c .)
  if [ "${count:-0}" -gt 0 ]; then
    tmux set-window-option -t "$win" @agent_count "$count"
  else
    tmux set-window-option -u -t "$win" @agent_count
  fi
done < <(grep '|on$' <<<"$panes")
