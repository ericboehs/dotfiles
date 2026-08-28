#!/usr/bin/env bash
# Compute the status bar's busy signal (@agent_count) fresh on
# every status refresh via #() in status-format[0], next to theme-sync.sh.
#
# A background window dims its index while any of its panes is working:
#   * a pane flagged @agent_running by pi's tmux-attention extension or
#     Claude's claude-agent-state.sh hook, or
#   * a shell running something that isn't interactive: foreground command
#     outside the ignore list AND not on the alternate screen. TUI apps
#     (vim, less, htop) flip alt-screen; batch jobs (cargo build, rspec) don't.
#
# Cost control — tmux may re-run #() on every redraw, once per attached client:
#   * A per-server timestamp and atomic lock collapse those redraws into one
#     sweep per AGENT_SYNC_INTERVAL (five seconds by default).
#   * Agents leave a sticky @agent_pane=<agent pid> marker on their pane while
#     their session lives. Idle agents report odd foreground commands ("node",
#     bare version strings) that would otherwise look like jobs; the marker
#     excludes them from the command heuristic and is checked with kill -0
#     (a syscall, no fork). It also survives crash/restart of the sweep logic.
#   * The ps snapshot happens ONLY while some turn is flagged as running —
#     it validates the flag against a live process so a kill -9'd agent can't
#     dim its window forever.
#   * tmux options are only written when a value actually changed.
#
# The ignore list defaults below; override with the @busy_ignore option:
#   tmux set-option -g @busy_ignore "zsh fish python3 ..."

# Two attached clients otherwise launch two full process-table scans together,
# and active pane output can retrigger them between status-interval ticks. Keep
# the throttle per tmux server so independent servers still maintain their own
# pane options. Setting AGENT_SYNC_INTERVAL=0 keeps only the concurrency lock.
interval=${AGENT_SYNC_INTERVAL:-5}
case $interval in ''|*[!0-9]*) interval=5 ;; esac
server_id=${TMUX#*,}; server_id=${server_id%%,*}
run_cache=${TMPDIR:-/tmp}/tmux-agent-sync-run.$EUID.${server_id:-unknown}
run_lock=$run_cache.lock
now=$(printf '%(%s)T' -1)
read -r last_run 2>/dev/null <"$run_cache"
if [[ $last_run =~ ^[0-9]+$ ]] && ((now - last_run < interval)); then
  exit 0
fi

if ! mkdir "$run_lock" 2>/dev/null; then
  # Recover from a process killed while holding the lock; a sweep never takes
  # remotely close to a minute under normal conditions.
  if [[ -n $(find "$run_lock" -maxdepth 0 -mmin +1 2>/dev/null) ]]; then
    rmdir "$run_lock" 2>/dev/null
    mkdir "$run_lock" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$run_lock" 2>/dev/null' EXIT

# The other client may have completed while this process was acquiring the lock.
read -r last_run 2>/dev/null <"$run_cache"
if [[ $last_run =~ ^[0-9]+$ ]] && ((now - last_run < interval)); then
  exit 0
fi

ignore=$(tmux show-options -gv @busy_ignore 2>/dev/null)
ignore=${ignore:-zsh bash fish sh nu ksh dash pwsh \
  ssh mosh-client \
  python python3 ipython irb pry node deno bun \
  psql pgcli sqlite3 mysql redis-cli}

# One round trip for all pane state. Flag field is followed by another '|', so
# a bash-native substring test finds flags without spawning grep.
panes=$(tmux list-panes -a \
  -F '#{window_id}|#{pane_id}|#{pane_tty}|#{pane_current_command}|#{alternate_on}|#{window_active}|#{@agent_running}|#{@agent_count}|#{@agent_pane}')

case $panes in *'|on|'*) have_flags=1 ;; *) have_flags=0 ;; esac

# The tty check below needs a ps snapshot whenever some turn is flagged — but
# also when any UNMARKED pane runs an agent-like command ("node", "claude",
# "pi", bare version strings like "2.1.245"). Sessions started before the
# marker convention exist, and skipping ps would let the job heuristic
# misread those idle agents as jobs — complete them spuriously, even.
have_suspects=0
while IFS='|' read -r _win _pane _tty cmd _alt _active flag _count _marker; do
  [ "$flag" = on ] && { have_flags=1; break; }
  [ -n "$marker" ] && continue
  case $cmd in
    claude|pi|node|[0-9]*.[0-9]*)
      have_suspects=1 ;;
  esac
done <<<"$panes"

live=" "
if [ "$have_flags" = 1 ] || [ "$have_suspects" = 1 ]; then
  # Which ttys host an agent process? Word-split each line: $1=tty, $2=argv[0],
# $3=argv[1]. pi is caught both directly and via "node .../bin/pi".
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
fi

# Roll up per-window counts. bash 3.2 has no associative arrays, so track
# windows/counts/previous-values in parallel arrays (a handful of entries).
# A pane that was busy last sweep but isn't now just finished a job: its
# window gets @job_done (rendered as a plain ·) until the user focuses it.
# Last sweep's busy panes persist in a small state file, since every run is
# a fresh process.
wins=(); counts=(); prevs=()
state=${XDG_CACHE_HOME:-$HOME/.cache}/tmux-agent-sync.state
mkdir -p "${state%/*}" 2>/dev/null
oldbusy=" $(cat "$state" 2>/dev/null) "
newbusy=""
done_windows=""
while IFS='|' read -r win pane tty cmd alt active flag oldcount marker; do
  case "$live" in *" ${tty#/dev/} "* ) live_agent=1 ;; *) live_agent=0 ;; esac

  # Sticky marker: alive means an agent session owns this pane — trust its
  # turn flag exclusively and never apply the command heuristic to it.
  marked=0
  if [ -n "$marker" ]; then
    if kill -0 "$marker" 2>/dev/null; then
      marked=1
    else
      # Agent died harshly: drop its marker (and any stale flag).
      [ "$flag" = on ] && tmux set-option -p -u -t "$pane" @agent_running
      tmux set-option -p -u -t "$pane" @agent_pane
      flag=""
    fi
  fi

  if [ "$flag" = on ] && [ "$marked" = 0 ] && [ "$live_agent" = 0 ]; then
    # Unmarked pane claiming to be mid-turn with no process behind it: clear.
    tmux set-option -p -u -t "$pane" @agent_running
    flag=""
  fi

  work=0
  if [ "$flag" = on ]; then
    work=1
  elif [ "$marked" = 0 ] && [ "$live_agent" = 0 ] && [ "$alt" = 0 ] && [ -n "$cmd" ]; then
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
  [ "$work" = 1 ] && counts[i]=$(( counts[i] + 1 ))

  # Job completion: busy last sweep, idle now. Only announce on background
  # windows — if the user is watching the pane, they saw it finish.
  if [ "$work" = 1 ]; then
    newbusy="$newbusy$pane "
  elif [ "$marked" = 0 ] && [ "$live_agent" = 0 ] && case "$oldbusy" in *" $pane "*) true ;; *) false ;; esac; then
    case "$done_windows" in *"$win "*) ;; *)
      [ "$active" = 0 ] && tmux set-window-option -t "$win" @job_done on
      done_windows="$done_windows$win " ;;
    esac
  fi
done <<<"$panes"

# Persist the busy set for next sweep's comparison; skip the write when the
# set didn't change.
case " $newbusy" in " $oldbusy") ;; *) printf '%s' "$newbusy" >| "$state" ;; esac

# Only touch tmux when a window's value actually changed, to avoid churn.
i=0
while [ "$i" -lt "${#wins[@]}" ]; do
  c=${counts[$i]}
  if ! { [ "$c" = "${prevs[$i]}" ] || { [ "$c" -eq 0 ] && [ -z "${prevs[$i]}" ]; }; }; then
    if [ "$c" -eq 0 ]; then
      tmux set-window-option -u -t "${wins[$i]}" @agent_count
    else
      tmux set-window-option -t "${wins[$i]}" @agent_count "$c"
    fi
  fi
  i=$((i+1))
done

# Publish only after a complete sweep. Atomic replacement means every redraw
# sees either the previous successful timestamp or this one, never a partial.
printf '%s\n' "$now" >"$run_cache.$$" && mv -f "$run_cache.$$" "$run_cache"
