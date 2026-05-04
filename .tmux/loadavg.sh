#!/usr/bin/env bash
# Print 1m,5m,15m load averages, coloring each red if it exceeds CPU count.

ncpu=$(sysctl -n hw.ncpu)
read -r _ one five fifteen _ < <(sysctl -n vm.loadavg)

color() {
  local v=$1
  if awk -v v="$v" -v n="$ncpu" 'BEGIN{exit !(v+0 > n+0)}'; then
    printf '#[fg=red]%s#[fg=default]' "$v"
  else
    printf '%s' "$v"
  fi
}

printf '%s, %s, %s' "$(color "$one")" "$(color "$five")" "$(color "$fifteen")"
