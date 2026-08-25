#!/usr/bin/env bash
# Compute the status bar's busy signal (@agent_count) fresh on every status
# refresh via #() in status-format[0], next to theme-sync.sh.
#
# A background window dims its index while any of its panes is working:
#   * a pane flagged @agent_running by pi's tmux-attention extension or
#     Claude's claude-agent-state.sh hook (agents idle at their prompt still
#     report odd foreground commands — "node", bare version strings — so they
#     are counted by flag alone, never by command), or
#   * a shell running something that isn't interactive: foreground command
#     outside the ignore list AND not on the alternate screen. TUI apps
#     (vim, less, htop) flip alt-screen; batch jobs (cargo build, rspec) don't.
#
# The ps snapshot doubles as the crash safety net: a flag whose agent died
# (kill -9, crash) gets cleared instead of dimming its window forever.
#
# The ignore list defaults below; override with the @busy_ignore option:
#   tmux set-option -g @busy_ignore "zsh fish python3 ..."
# NB: tmux's #{pane_tty} is /dev/ttysN while ps reports bare ttysN.

ignore=$(tmux show-options -gv @busy_ignore 2>/dev/null)
ignore=${ignore:-zsh bash fish sh nu ksh dash pwsh \
  ssh mosh-client \
  python python3 ipython irb pry node deno bun \
  psql pgcli sqlite3 mysql redis-cli}

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

# Roll up per-window counts. bash 3.2 has no associative arrays, so track
# windows/counts/previous-values in parallel arrays (a handful of entries).
wins=(); counts=(); prevs=()
while IFS='|' read -r win pane tty cmd alt flag oldcount; do
  case "$live" in *" ${tty#/dev/} "* ) agent=1 ;; *) agent=0 ;; esac

  if [ "$flag" = on ] && [ "$agent" = 0 ]; then
    # Flag outlived its process: clear it so this pass treats the pane honestly.
    tmux set-option -p -u -t "$pane" @agent_running
    flag=""
  fi

  work=0
  if [ "$flag" = on ]; then
    work=1
  elif [ "$agent" = 0 ] && [ "$alt" = 0 ] && [ -n "$cmd" ]; then
    work=1
    # Versioned binaries report themselves with their full name (python3.14,
    # node22), so match both the raw command and its version-stripped form.
    stripped=${cmd%%[0-9]*}
    # shellcheck disable=SC2086  # intentional word split of the ignore list
    for w in $ignore; do
      [ "$w" = "$cmd" ] && { work=0; break; }
      [ -n "$stripped" ] && [ "$w" = "$stripped" ] && { work=0; break; }
    done
  fi

  i=0
  while [ "$i" -lt "${#wins[@]}" ] && [ "${wins[$i]}" != "$win" ]; do i=$((i+1)); done
  if [ "$i" -eq "${#wins[@]}" ]; then
    wins+=("$win"); counts+=(0); prevs+=("$oldcount")
  fi
  [ "$work" = 1 ] && counts[$i]=$(( ${counts[$i]} + 1 ))
done < <(tmux list-panes -a \
  -F '#{window_id}|#{pane_id}|#{pane_tty}|#{pane_current_command}|#{alternate_on}|#{@agent_running}|#{@agent_count}')

# Only touch tmux when a window's value actually changed, to avoid churn on
# every refresh.
i=0
while [ "$i" -lt "${#wins[@]}" ]; do
  c=${counts[$i]}
  if [ "$c" = "${prevs[$i]}" ] || { [ "$c" -eq 0 ] && [ -z "${prevs[$i]}" ]; }; then
    i=$((i+1)); continue
  fi
  if [ "$c" -eq 0 ]; then
    tmux set-window-option -u -t "${wins[$i]}" @agent_count
  else
    tmux set-window-option -t "${wins[$i]}" @agent_count "$c"
  fi
  i=$((i+1))
done
