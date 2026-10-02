#!/usr/bin/env bash
# One long-lived status helper per tmux server. It replaces the four #()
# helpers status-format used to run (theme-sync, agent-sync, gpu, loadavg).
#
# Why: tmux re-runs a #() on almost every redraw, up to once a second per
# attached client, and each run was a chain of execs (sh -> env -> bash ->
# mkdir/find/mv/awk...) even when the script only read its cache. Two clients
# and four helpers came to ~50 execs a second. On the VA Mac every exec is
# written to the BSM audit trail and scanned by Defender, so the status bar
# alone kept auditd pegged at a full core and wrote ~25 GB of audit log a day.
#
# Now a redraw forks nothing. This loop samples on its own clock and publishes
# the results as tmux options, which status-format reads with #{E:...}:
#
#   @status_gpu    GPU utilization + memory, empty unless it earns the space
#   @status_load   1m,5m,15m load averages, same rule
#   @agent_count   per window: panes working (dims the index)
#   @job_done      per window: a job finished in the background (brightens it)
#
# and runs theme-sync.sh only when the system appearance actually flips.
#
# Cadence: the loop wakes every second but only checks appearance every two
# (on macOS it asks `defaults` only when the global prefs plist changed, with a
# 30s fallback) and does everything else every five. Sleeping is `read -t` on
# a private FIFO, so idle ticks spawn nothing. A five-second sweep costs about
# four execs (sysctl, ioreg, tmux list-panes, and tmux set when a value moved).
#
# Lifecycle: started from tmux.conf with `run-shell -b`. A per-server pid file
# keeps it to one copy across config reloads; it exits when the server goes
# away. Saving this file restarts it in place (it re-execs when the script is
# newer than its start marker), so edits land within a second.
#
#   ~/.tmux/status-daemon.sh status   is one running for this server?

[ -n "$TMUX" ] || { echo "status-daemon: not inside tmux" >&2; exit 1; }
server_pid=${TMUX#*,}; server_pid=${server_pid%%,*}
case $server_pid in ''|*[!0-9]*) echo "status-daemon: bad \$TMUX" >&2; exit 1 ;; esac

self=$0
dir=${self%/*}
run_dir=${TMPDIR:-/tmp}; run_dir=${run_dir%/}/tmux-status-daemon.$EUID.$server_pid
pid_file=$run_dir/pid
cache_dir=${XDG_CACHE_HOME:-$HOME/.cache}
log_file=$cache_dir/tmux-status-daemon.log

running_pid() {
  local other
  read -r other 2>/dev/null <"$pid_file"
  [[ $other =~ ^[0-9]+$ ]] && kill -0 "$other" 2>/dev/null && REPLY=$other
}

if [ "${1:-}" = status ]; then
  REPLY=
  if running_pid; then echo "running (pid $REPLY, server $server_pid)"; else echo "not running"; exit 1; fi
  exit 0
fi

# --- single instance ---------------------------------------------------------
[ -d "$run_dir" ] || mkdir -p "$run_dir" || exit 1
REPLY=
if running_pid && [ "$REPLY" != $$ ]; then
  exit 0 # already running for this server (re-exec keeps our pid, so allow it)
fi
echo $$ >"$pid_file"

# Detach from the run-shell job's pipe, and from whatever directory the session
# was in, so the daemon never holds a mount (say, /Volumes/Sabrent) busy.
cd / || exit 1
exec </dev/null >/dev/null 2>/dev/null
[ -d "$cache_dir" ] || mkdir -p "$cache_dir"

log() { printf '%(%F %T)T [%d] %s\n' -1 $$ "$*" >>"$log_file"; }

cleanup() {
  local other
  read -r other 2>/dev/null <"$pid_file"
  [ "$other" = $$ ] && rm -rf "$run_dir"
  log "exit"
}
trap cleanup EXIT
trap 'exit 0' TERM HUP INT

[ -p "$run_dir/tick" ] || mkfifo "$run_dir/tick" || exit 1
exec {tick_fd}<>"$run_dir/tick"
started=$run_dir/started
echo $$ >"$started"
log "start (server $server_pid)"

[[ $OSTYPE == darwin* ]] && is_darwin=1 || is_darwin=0
command -v nvidia-smi >/dev/null 2>&1 && have_nvidia=1 || have_nvidia=0
if ((is_darwin)); then
  ncpu=$(sysctl -n hw.ncpu)
elif [[ -r /proc/cpuinfo ]]; then
  ncpu=0
  while read -r line; do [[ $line == processor* ]] && ((ncpu++)); done </proc/cpuinfo
fi
[[ $ncpu =~ ^[1-9][0-9]*$ ]] || ncpu=1

# --- appearance ----------------------------------------------------------------
# The palettes live in theme-sync.sh; this only decides when to call it.
prefs=$HOME/Library/Preferences/.GlobalPreferences.plist
prefs_seen=$run_dir/prefs-seen
theme_mode=
theme_checked=0

theme_check() {
  local mode out
  if ((is_darwin)); then
    if [[ $prefs -nt $prefs_seen ]] || ((now - theme_checked >= 30)); then
      echo "$now" >"$prefs_seen"
      theme_checked=$now
      out=$(defaults read -g AppleInterfaceStyle 2>/dev/null)
      [[ $out == *Dark* ]] && mode=dark || mode=light
    else
      return
    fi
  else
    # bin/appearance's Linux answer, minus LC_APPEARANCE: a server started by
    # an SSH connection inherits a value resolved at connect time (see
    # theme-sync.sh). appearance-push keeps this file fresh.
    mode=dark
    [[ -s $HOME/.cache/dark-mode ]] && read -r mode <"$HOME/.cache/dark-mode"
    [[ $mode == light ]] || mode=dark
  fi
  [[ $mode == "$theme_mode" ]] && return
  theme_mode=$mode
  log "appearance: $mode"
  "$dir/theme-sync.sh" "$mode" </dev/null >/dev/null 2>&1
}

# --- load average ------------------------------------------------------------
# Three bands, so the number only asks for attention once it has earned it:
#   < half the CPUs   quiet, same grey as the rest of the status bar
#   >= half           yellow, the machine is working
#   > CPU count       red, runnable work is queueing behind the CPUs
# The segment appears once any average reaches yellow. After they fall back,
# the trio holds LOADAVG_LINGER seconds in grey so a spike cannot blink it in
# and out, then the right side is just the clock.
load_linger=${LOADAVG_LINGER:-30}
load_busy=

# "6.48" -> 648, without awk: bash only does integer math.
hundredths() {
  local v=$1 i f
  i=${v%%.*}; f=0
  [[ $v == *.* ]] && f=${v#*.}
  f=${f}00; f=${f:0:2}
  REPLY=$((10#${i:-0} * 100 + 10#$f))
}

load_band() { # value -> REPLY rendered with color formats
  local v=$1 shown
  printf -v shown '%.1f' "$v"
  hundredths "$v"
  if ((REPLY > ncpu * 100)); then
    REPLY="#[fg=#{@load_crit_fg}]$shown#[fg=#{@time_fg}]"
  elif ((REPLY * 2 >= ncpu * 100)); then
    REPLY="#[fg=#{@load_warn_fg}]$shown#[fg=#{@time_fg}]"
  else
    REPLY=$shown
  fi
}

sample_load() { # -> load_str
  local one five fifteen out a b c v visible=0
  if [[ -r /proc/loadavg ]]; then
    read -r one five fifteen _ </proc/loadavg
  else
    out=$(sysctl -n vm.loadavg) # "{ 1.23 4.56 7.89 }"
    read -r _ one five fifteen _ <<<"$out"
  fi
  [[ $one && $five && $fifteen ]] || { load_str=; return; }
  for v in "$one" "$five" "$fifteen"; do
    hundredths "$v"
    ((REPLY * 2 >= ncpu * 100)) && visible=1
  done
  if ((visible)); then
    load_band "$one"; a=$REPLY
    load_band "$five"; b=$REPLY
    load_band "$fifteen"; c=$REPLY
    load_str="$a $b $c"
    load_busy=$now
  elif [[ $load_busy ]] && ((now - load_busy < load_linger)); then
    printf -v load_str '%.1f %.1f %.1f' "$one" "$five" "$fifteen"
  else
    load_str=
  fi
}

# --- GPU -----------------------------------------------------------------------
# Utilization rides the same bands as the load average (GPU_WARN/GPU_CRIT
# percent); memory stays grey, since on unified memory it is a size, not a
# pressure reading. Lingers GPU_LINGER seconds past the last yellow sample.
# Prints nothing when no GPU can be read.
gpu_warn=${GPU_WARN:-60}
gpu_crit=${GPU_CRIT:-90}
gpu_linger=${GPU_LINGER:-30}
gpu_busy=
gpu_absent=0
re_util='"Device Utilization %"=([0-9]+)'
re_mem='"In use system memory"=([0-9]+)'

# Bytes to the shortest honest size: 815710208 -> 0.8G, 11013603328 -> 11G.
human() {
  local b=$1 g=1073741824 t
  if ((b >= 10 * g)); then
    REPLY="$(((b + g / 2) / g))G"
  else
    t=$(((b * 10 + g / 2) / g))
    if ((t >= 1)); then REPLY="$((t / 10)).$((t % 10))G"; else REPLY=; fi
  fi
}

read_gpu() { # -> util mem
  local out f
  util='' mem=''
  if ((is_darwin)); then
    # One ioreg call covers both numbers, readable without sudo.
    out=$(ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null)
    [[ $out =~ $re_util ]] && util=${BASH_REMATCH[1]}
    [[ $out =~ $re_mem ]] && mem=${BASH_REMATCH[1]}
  elif ((have_nvidia)); then
    out=$(nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>/dev/null)
    out=${out%%$'\n'*}
    if [[ $out =~ ^\ *([0-9]+),\ *([0-9]+) ]]; then
      util=${BASH_REMATCH[1]}
      mem=$((BASH_REMATCH[2] * 1048576)) # MiB
    fi
  else
    # amdgpu and recent i915 export the percentage via drm, amdgpu VRAM too.
    for f in /sys/class/drm/card*/device/gpu_busy_percent; do
      [[ -r $f ]] || continue
      read -r util <"$f"
      [[ -r ${f%/*}/mem_info_vram_used ]] && read -r mem <"${f%/*}/mem_info_vram_used"
      break
    done
    [[ $util ]] || gpu_absent=1 # no GPU on this box; stop probing
  fi
}

sample_gpu() { # -> gpu_str
  local util mem fg
  gpu_str=
  ((gpu_absent)) && return
  read_gpu
  [[ $util =~ ^[0-9]+$ ]] || return
  ((util >= gpu_warn)) && gpu_busy=$now
  if ((util < gpu_warn)); then
    [[ $gpu_busy ]] && ((now - gpu_busy < gpu_linger)) || return
  fi
  if ((util >= gpu_crit)); then fg='#{@load_crit_fg}'
  elif ((util >= gpu_warn)); then fg='#{@load_warn_fg}'
  else fg='#{@time_fg}'; fi
  # %% because status-format output goes through strftime.
  gpu_str="#[fg=$fg]$util%%#[fg=#{@time_fg}]"
  if [[ $mem =~ ^[0-9]+$ ]]; then
    human "$mem"
    [[ $REPLY ]] && gpu_str+=" $REPLY"
  fi
  gpu_str+=' '
}

# --- agent / job state ---------------------------------------------------------
# A background window dims its index while any of its panes is working:
#   * a pane flagged @agent_running by pi's tmux-attention extension or
#     Claude's claude-agent-state.sh hook, or
#   * a shell running something that isn't interactive: foreground command
#     outside the ignore list AND not on the alternate screen. TUI apps
#     (vim, less, htop) flip alt-screen; batch jobs (cargo build, rspec) don't.
# A pane that was busy last sweep but isn't now just finished a job: its
# window gets @job_done (a bright index) until the user focuses it.
#
# Agents leave a sticky @agent_pane=<agent pid> marker on their pane while
# their session lives. Idle agents report odd foreground commands ("node",
# bare version strings) that would otherwise look like jobs; the marker
# excludes them from the command heuristic and is checked with kill -0.
# The ps snapshot only happens while some turn is flagged running or an
# unmarked pane runs an agent-like command, to validate those against a live
# process so a kill -9'd agent can't dim its window forever.
#
# Override the ignore list with: tmux set-option -g @busy_ignore "zsh fish ..."
default_ignore='zsh bash fish sh nu ksh dash pwsh ssh mosh-client python python3 ipython irb pry node deno bun psql pgcli sqlite3 mysql redis-cli'
busy_state=$cache_dir/tmux-agent-sync.state
oldbusy=" $(<"$busy_state") "
pane_fmt='#{window_id}|#{pane_id}|#{pane_tty}|#{pane_current_command}|#{alternate_on}|#{window_active}|#{@agent_running}|#{@agent_count}|#{@agent_pane}|#{@job_done}'

# Queue tmux commands; sweep() sends the whole batch in one tmux call.
tq() {
  ((${#tcmds[@]})) && tcmds+=(';')
  tcmds+=("$@")
}

agent_sweep() { # queues window/pane option changes onto tcmds
  local out ignore panes have_flags=0 have_suspects=0 live=" " line base
  local win pane tty cmd alt active flag oldcount marker jobdone
  local live_agent marked work stripped w i c newbusy='' done_windows=''
  local -a wins=() counts=() prevs=() win_jobdone=()

  # One round trip for the ignore list and all pane state.
  out=$(tmux display-message -p '#{@busy_ignore}' \; list-panes -a -F "$pane_fmt" 2>/dev/null) || return 1
  ignore=${out%%$'\n'*}
  panes=${out#*$'\n'}
  ignore=${ignore:-$default_ignore}

  while IFS='|' read -r win pane tty cmd alt active flag oldcount marker jobdone; do
    [ "$flag" = on ] && { have_flags=1; break; }
    [ -n "$marker" ] && continue
    case $cmd in claude|pi|node|[0-9]*.[0-9]*) have_suspects=1 ;; esac
  done <<<"$panes"

  if ((have_flags || have_suspects)); then
    # Which ttys host an agent process? $1=tty, $2=argv[0], $3=argv[1].
    # pi is caught both directly and via "node .../bin/pi".
    while IFS= read -r line; do
      # shellcheck disable=SC2086  # intentional word split
      set -- $line
      [ $# -ge 2 ] || continue
      base=${2##*/}
      case $base in
        claude|pi) live="$live$1 " ;;
        node) [ "${3##*/}" = pi ] && live="$live$1 " ;;
      esac
    done < <(ps -axo tty=,args=)
  fi

  while IFS='|' read -r win pane tty cmd alt active flag oldcount marker jobdone; do
    [ -n "$pane" ] || continue
    case "$live" in *" ${tty#/dev/} "*) live_agent=1 ;; *) live_agent=0 ;; esac

    # Sticky marker: alive means an agent session owns this pane, so trust
    # its turn flag exclusively and never apply the command heuristic.
    marked=0
    if [ -n "$marker" ]; then
      if kill -0 "$marker" 2>/dev/null; then
        marked=1
      else
        [ "$flag" = on ] && tq set-option -p -u -t "$pane" @agent_running
        tq set-option -p -u -t "$pane" @agent_pane
        flag=
      fi
    fi

    if [ "$flag" = on ] && ((marked == 0 && live_agent == 0)); then
      # Unmarked pane claiming to be mid-turn with no process behind it.
      tq set-option -p -u -t "$pane" @agent_running
      flag=
    fi

    work=0
    if [ "$flag" = on ]; then
      work=1
    elif ((marked == 0 && live_agent == 0)) && [ "$alt" = 0 ] && [ -n "$cmd" ]; then
      work=1
      # Versioned binaries report their full name (python3.14, node22), so
      # match both the raw command and its version-stripped form.
      stripped=${cmd%%[0-9]*}
      # shellcheck disable=SC2086  # intentional word split of the ignore list
      for w in $ignore; do
        [ "$w" = "$cmd" ] && { work=0; break; }
        [ -n "$stripped" ] && [ "$w" = "$stripped" ] && { work=0; break; }
      done
    fi

    i=0
    while ((i < ${#wins[@]})) && [ "${wins[i]}" != "$win" ]; do ((i++)); done
    if ((i == ${#wins[@]})); then
      wins+=("$win"); counts+=(0); prevs+=("$oldcount"); win_jobdone+=("$jobdone")
    fi
    ((work)) && ((counts[i]++))

    # Busy last sweep, idle now. Only announce on background windows: if the
    # user is watching the pane, they saw it finish.
    if ((work)); then
      newbusy+="$pane "
    elif ((marked == 0 && live_agent == 0)) && [[ $oldbusy == *" $pane "* ]]; then
      case "$done_windows" in *"$win "*) ;; *)
        [ "$active" = 0 ] && tq set-window-option -t "$win" @job_done on
        done_windows+="$win " ;;
      esac
    fi
  done <<<"$panes"

  if [ " $newbusy" != "$oldbusy" ]; then
    printf '%s' "$newbusy" >|"$busy_state"
    oldbusy=" $newbusy"
  fi

  # Only touch tmux when a window's value actually changed.
  for ((i = 0; i < ${#wins[@]}; i++)); do
    c=${counts[i]}
    if ! { [ "$c" = "${prevs[i]}" ] || { ((c == 0)) && [ -z "${prevs[i]}" ]; }; }; then
      if ((c == 0)); then
        tq set-window-option -u -t "${wins[i]}" @agent_count
      else
        tq set-window-option -t "${wins[i]}" @agent_count "$c"
      fi
    fi
    # A window working again shows dim, not bright: drop a stale completion
    # flag so @job_done never outranks @agent_count.
    if ((c > 0)); then
      if [ "${win_jobdone[i]}" = on ] || [[ $done_windows == *"${wins[i]} "* ]]; then
        tq set-window-option -u -t "${wins[i]}" @job_done
      fi
    fi
  done
  return 0
}

published_gpu=$'\x01' published_load=$'\x01' # force the first publish
tmux_failures=0

sweep() {
  local gpu_str load_str
  tcmds=()
  sample_gpu
  sample_load
  # Status strings go first: tmux drops the rest of a command list after an
  # error, and a pane can vanish between list-panes and set-option.
  if [[ $gpu_str != "$published_gpu" || $load_str != "$published_load" ]]; then
    tq set-option -gq @status_gpu "$gpu_str"
    tq set-option -gq @status_load "$load_str"
    published_gpu=$gpu_str published_load=$load_str
  fi
  if agent_sweep; then
    tmux_failures=0
  elif ((++tmux_failures >= 3)); then
    log "tmux unreachable, exiting"
    exit 0
  fi
  ((${#tcmds[@]})) && tmux "${tcmds[@]}" 2>/dev/null
}

# --- main loop -------------------------------------------------------------------
sweep_interval=${STATUS_DAEMON_INTERVAL:-5}
theme_interval=2
last_sweep=0
last_theme=0
while :; do
  kill -0 "$server_pid" 2>/dev/null || exit 0
  if [[ $self -nt $started ]]; then
    if bash -n "$self" 2>/dev/null; then
      log "script changed, re-exec"
      exec {tick_fd}>&-
      exec "$self"
    fi
    echo $$ >"$started" # broken edit: keep running the old code until the next save
  fi
  printf -v now '%(%s)T' -1
  if ((now - last_theme >= theme_interval)); then
    last_theme=$now
    theme_check
  fi
  if ((now - last_sweep >= sweep_interval)); then
    last_sweep=$now
    sweep
  fi
  read -rt 1 -u "$tick_fd"
done
