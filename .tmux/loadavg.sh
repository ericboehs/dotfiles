#!/usr/bin/env bash
# Print 1m,5m,15m load averages on a three-band scale, so the number only asks
# for attention once it has earned it:
#
#   < half the CPUs   quiet, same grey as the rest of the status bar
#   >= half           yellow, the machine is working
#   > CPU count       red, runnable work is queueing behind the CPUs

# tmux evaluates #() separately for every attached client and may do so on
# redraws between status-interval ticks. The load numbers only need the same
# five-second cadence as the status bar, so share the rendered result per tmux
# server. Set LOADAVG_INTERVAL=0 to keep only concurrent-call deduplication.
interval=${LOADAVG_INTERVAL:-5}
case $interval in ''|*[!0-9]*) interval=5 ;; esac
server_id=${TMUX#*,}; server_id=${server_id%%,*}
cache=${TMPDIR:-/tmp}/tmux-loadavg.$EUID.${server_id:-unknown}
lock=$cache.lock
now=$(printf '%(%s)T' -1)
IFS=$'\t' read -r stamp cached 2>/dev/null <"$cache"
if [[ $stamp =~ ^[0-9]+$ ]] && ((now - stamp < interval)); then
  printf '%s' "$cached"
  exit 0
fi

if ! mkdir "$lock" 2>/dev/null; then
  # A slightly stale value is preferable to a blank status segment while the
  # other client refreshes it. Recover abandoned locks after one minute.
  if [[ -n $(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null) ]]; then
    rmdir "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || exit 0
  else
    [[ -n $cached ]] && printf '%s' "$cached"
    exit 0
  fi
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

# Another client may have refreshed the cache immediately before lock acquire.
IFS=$'\t' read -r stamp cached 2>/dev/null <"$cache"
if [[ $stamp =~ ^[0-9]+$ ]] && ((now - stamp < interval)); then
  printf '%s' "$cached"
  exit 0
fi

# Linux keeps both in /proc; macOS has neither, and answers via sysctl instead.
if [[ -r /proc/loadavg ]]; then
  ncpu=$(nproc)
  read -r one five fifteen _ < /proc/loadavg
else
  ncpu=$(sysctl -n hw.ncpu)
  # vm.loadavg is brace-wrapped: "{ 1.23 4.56 7.89 }".
  read -r _ one five fifteen _ < <(sysctl -n vm.loadavg)
fi

# Reset to @time_fg rather than "default": the surrounding status-format sets
# @time_fg before calling this, and "default" would reset to the brighter
# status-style fg, leaving later numbers lighter than the earlier ones.
IFS=' ' read -r base_fg warn_fg crit_fg < <(
  tmux display -p '#{@time_fg} #{@load_warn_fg} #{@load_crit_fg}'
)

color() {
  local v=$1 band
  # awk, because loads are floats and bash only compares integers.
  band=$(awk -v v="$v" -v n="$ncpu" \
    'BEGIN { print (v+0 > n+0) ? "crit" : (v+0 >= n/2) ? "warn" : "ok" }')

  # Both sources report two decimals; the second one only ever adds width.
  v=$(printf '%.1f' "$v")

  case $band in
    crit) printf '#[fg=%s]%s#[fg=%s]' "${crit_fg:-red}" "$v" "${base_fg:-default}" ;;
    warn) printf '#[fg=%s]%s#[fg=%s]' "${warn_fg:-yellow}" "$v" "${base_fg:-default}" ;;
    *)    printf '%s' "$v" ;;
  esac
}

rendered=$(printf '%s %s %s' \
  "$(color "$one")" "$(color "$five")" "$(color "$fifteen")")
printf '%s\t%s\n' "$now" "$rendered" >"$cache.$$" && mv -f "$cache.$$" "$cache"
printf '%s' "$rendered"
