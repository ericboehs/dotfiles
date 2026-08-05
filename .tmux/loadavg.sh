#!/usr/bin/env bash
# Print 1m,5m,15m load averages on a three-band scale, so the number only asks
# for attention once it has earned it:
#
#   < half the CPUs   quiet, same grey as the rest of the status bar
#   >= half           yellow, the machine is working
#   > CPU count       red, runnable work is queueing behind the CPUs

ncpu=$(sysctl -n hw.ncpu)
read -r _ one five fifteen _ < <(sysctl -n vm.loadavg)

# Reset to @time_fg rather than "default": the surrounding status-format sets
# @time_fg before calling this, and "default" would reset to the brighter
# status-style fg, leaving later numbers lighter than the earlier ones.
base_fg=$(tmux show-options -gqv @time_fg)
warn_fg=$(tmux show-options -gqv @load_warn_fg)
crit_fg=$(tmux show-options -gqv @load_crit_fg)

color() {
  local v=$1 band
  # awk, because loads are floats and bash only compares integers.
  band=$(awk -v v="$v" -v n="$ncpu" \
    'BEGIN { print (v+0 > n+0) ? "crit" : (v+0 >= n/2) ? "warn" : "ok" }')

  case $band in
    crit) printf '#[fg=%s]%s#[fg=%s]' "${crit_fg:-red}" "$v" "${base_fg:-default}" ;;
    warn) printf '#[fg=%s]%s#[fg=%s]' "${warn_fg:-yellow}" "$v" "${base_fg:-default}" ;;
    *)    printf '%s' "$v" ;;
  esac
}

printf '%s, %s, %s' "$(color "$one")" "$(color "$five")" "$(color "$fifteen")"
