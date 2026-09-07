#!/usr/bin/env bash
# Print 1m,5m,15m load averages on a three-band scale, so the number only asks
# for attention once it has earned it:
#
#   < half the CPUs   quiet, same grey as the rest of the status bar
#   >= half           yellow, the machine is working
#   > CPU count       red, runnable work is queueing behind the CPUs
#
# The segment only appears once some average reaches the yellow line. When the
# averages fall back below it, the trio holds for LOADAVG_LINGER seconds in the
# bar's grey — a one-sample spike cannot blink it in and out — and then the
# right side is just the clock.

# tmux evaluates #() separately for every attached client and may do so on
# redraws between status-interval ticks. The load numbers only need the same
# five-second cadence as the status bar, so share the rendered result per tmux
# server. Set LOADAVG_INTERVAL=0 to keep only concurrent-call deduplication.
interval=${LOADAVG_INTERVAL:-5}
case $interval in ''|*[!0-9]*) interval=5 ;; esac
linger=${LOADAVG_LINGER:-30}
server_id=${TMUX#*,}; server_id=${server_id%%,*}
cache=${TMPDIR:-/tmp}/tmux-loadavg.$EUID.${server_id:-unknown}
lock=$cache.lock
now=$(printf '%(%s)T' -1)
# The cache holds "<sampled-at> <rendered> <last-busy-at>" — last-busy being
# the newest sample at or above the yellow line, carried forward while the
# averages sit quiet so the linger can run out. Caches written before the
# third field existed read as an empty busy, which never expires.
IFS=$'\t' read -r stamp cached busy 2>/dev/null <"$cache"
if [[ $stamp =~ ^[0-9]+$ ]] && ((now - stamp < interval)); then
  if [[ ! $busy =~ ^[0-9]+$ ]] || ((now - busy < linger)); then
    printf '%s' "$cached"
  fi
  exit 0
fi

if ! mkdir "$lock" 2>/dev/null; then
  # A slightly stale value is preferable to a blank status segment while the
  # other client refreshes it. Recover abandoned locks after one minute.
  if [[ -n $(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null) ]]; then
    rmdir "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || exit 0
  else
    # Stale beats blank — but only while the linger still holds.
    if [[ -n $cached ]] && { [[ ! $busy =~ ^[0-9]+$ ]] || ((now - busy < linger)); }; then
      printf '%s' "$cached"
    fi
    exit 0
  fi
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

# Another client may have refreshed the cache immediately before lock acquire.
IFS=$'\t' read -r stamp cached busy 2>/dev/null <"$cache"
if [[ $stamp =~ ^[0-9]+$ ]] && ((now - stamp < interval)); then
  if [[ ! $busy =~ ^[0-9]+$ ]] || ((now - busy < linger)); then
    printf '%s' "$cached"
  fi
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

# The segment only earns its space once some average reaches the yellow line;
# below that the whole trio vanishes and the right side is just the clock.
visible=$(awk -v a="$one" -v b="$five" -v c="$fifteen" -v n="$ncpu" \
  'BEGIN { print (a+0 >= n/2 || b+0 >= n/2 || c+0 >= n/2) ? 1 : 0 }')

if ((visible)); then
  # Reset to @time_fg rather than "default": the surrounding status-format sets
  # @time_fg before calling this, and "default" would reset to the brighter
  # status-style fg, leaving later numbers lighter than the earlier ones.
  IFS=' ' read -r base_fg warn_fg crit_fg < <(
    tmux display -p '#{@time_fg} #{@load_warn_fg} #{@load_crit_fg}'
  )
  rendered=$(printf '%s %s %s' \
    "$(color "$one")" "$(color "$five")" "$(color "$fifteen")")
  busy_at=$now
elif [[ $busy =~ ^[0-9]+$ ]] && ((now - busy < linger)); then
  # Dipped below the yellow line while the linger holds: keep the trio up in
  # the bar's grey, the way gpu.sh holds a workload's idle dip. No tmux call
  # needed — quiet numbers carry no color of their own.
  rendered=$(printf '%.1f %.1f %.1f' "$one" "$five" "$fifteen")
  busy_at=$busy
else
  # Quiet past the linger. Carry the last yellow timestamp forward anyway —
  # the sampler is the only process that sees fresh readings.
  rendered=
  busy_at=$busy
fi

printf '%s\t%s\t%s\n' "$now" "$rendered" "$busy_at" >"$cache.$$" &&
  mv -f "$cache.$$" "$cache"
printf '%s' "$rendered"
