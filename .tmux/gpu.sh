#!/usr/bin/env bash
# Print GPU utilization and GPU memory in use for the status bar. The
# percentage rides the same three-band scale as loadavg.sh, so the numbers next
# to each other mean the same thing:
#
#   < 60%   quiet, same grey as the rest of the status bar
#   >= 60%  yellow, the GPU is working
#   >= 90%  red, the GPU is the bottleneck
#
# Memory stays grey: on unified memory it is a size, not a pressure reading.
#
# Prints nothing at all when no GPU can be read, so a box without one — or a
# Linux VM — just gets the load average where this would be.

warn_at=${GPU_WARN:-60}
crit_at=${GPU_CRIT:-90}

# tmux re-runs a status #() as often as once a second, on any redraw: a
# keypress, a pane focus, a window rename. The number is only worth sampling as
# often as status-interval, so cache it for that long and let the extra redraws
# read the file instead of spawning ioreg/nvidia-smi.
ttl=${GPU_INTERVAL:-5}
cache=${TMPDIR:-/tmp}/tmux-gpu.$(id -u)

read_gpu() {
  # Each branch prints "<percent> <bytes-in-use>", the second field empty when
  # only the percentage is available.

  # macOS: the accelerator publishes both in the IORegistry, readable without
  # sudo. powermetrics has the same numbers but needs root. One ioreg call
  # covers both, so the two never disagree about when they were sampled.
  if [[ $OSTYPE == darwin* ]]; then
    ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null | tr ',' '\n' | awk '
      /"Device Utilization %"=/  { if (u == "") { sub(/.*=/, ""); u = $0 } }
      /"In use system memory"=/  { if (m == "") { sub(/.*=/, ""); sub(/[^0-9].*/, ""); m = $0 } }
      END { print u, m }'
    return
  fi

  # Linux, NVIDIA. Costs ~100ms, which the cache below now pays only every ttl.
  # memory.used is MiB, so scale it to bytes like everyone else.
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>/dev/null |
      awk -F', *' 'NR == 1 { print $1, $2 * 1048576 }'
    return
  fi

  # Linux, AMD and recent Intel: amdgpu/i915 export the same percentage via drm,
  # and amdgpu the VRAM figure alongside it.
  local f mem
  for f in /sys/class/drm/card*/device/gpu_busy_percent; do
    [[ -r $f ]] || continue
    mem=$(cat "${f%/*}/mem_info_vram_used" 2>/dev/null)
    printf '%s %s\n' "$(cat "$f")" "$mem"
    return
  done
}

# Bytes to the shortest honest size: 815710208 -> 0.8G, 11013603328 -> 11G.
human() {
  awk -v b="$1" 'BEGIN {
    g = b / 1073741824
    if (g >= 10) printf "%dG", g + 0.5
    else if (g >= 0.05) printf "%.1fG", g
    else printf ""
  }'
}

# The cache holds "<sampled-at> <percent> <bytes>", so checking its age needs no
# stat(1), whose flags differ between macOS and Linux. A machine with no GPU
# caches the empty answer too, and so stops re-probing for one every second.
now=$(printf '%(%s)T' -1)
read -r stamp gpu mem 2>/dev/null <"$cache"

if [[ ! $stamp =~ ^[0-9]+$ ]] || ((now - stamp >= ttl)); then
  # Every attached client redraws its own status, so the expiry lands on all of
  # them in the same second. Left unguarded they each take their own
  # instantaneous sample — 78, 93, 100 — and race to write, which reads as the
  # number flickering off-cadence. mkdir is atomic on every filesystem that
  # matters, so exactly one process samples per interval.
  lock=$cache.lock
  sample=
  if mkdir "$lock" 2>/dev/null; then
    trap 'rmdir "$lock" 2>/dev/null' EXIT
    sample=1
  else
    # A sampler killed mid-run would otherwise freeze the number forever.
    # Nothing legitimately holds this for a minute.
    [[ -n $(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null) ]] && rmdir "$lock" 2>/dev/null
    # Cold start: with nothing cached to fall back on, losing the race would
    # mean printing nothing and leaving a hole in the status bar for a tick.
    [[ $gpu =~ ^[0-9]+$ ]] || sample=1
  fi

  if [[ -n $sample ]]; then
    read -r fresh fresh_mem < <(read_gpu)
    # Write via a temp file so a reader can never catch a half-written line.
    printf '%s %s %s\n' "$now" "$fresh" "$fresh_mem" >"$cache.$$" && mv -f "$cache.$$" "$cache"
    # Then keep showing what every other client is showing, and let the new
    # numbers land on the next tick, so no two clients are ever a redraw out of
    # step. Only a cold start, with nothing cached, prints its own sample.
    [[ $gpu =~ ^[0-9]+$ ]] || { gpu=$fresh; mem=$fresh_mem; }
  fi
fi

[[ $gpu =~ ^[0-9]+$ ]] || exit 0

# One tmux call for all three colors instead of three show-options calls: this
# runs on every redraw, cache or not.
IFS=' ' read -r base_fg warn_fg crit_fg < <(
  tmux display -p '#{@time_fg} #{@load_warn_fg} #{@load_crit_fg}'
)

if ((gpu >= crit_at)); then
  fg=${crit_fg:-red}
elif ((gpu >= warn_at)); then
  fg=${warn_fg:-yellow}
else
  fg=${base_fg:-default}
fi

# Reset to @time_fg rather than "default", for the same reason loadavg.sh does:
# "default" would jump back to the brighter status-style fg. The trailing space
# lives here so the separator disappears along with the numbers when there is no
# GPU to report.
base_fg=${base_fg:-default}
printf '#[fg=%s]%s%%#[fg=%s]' "$fg" "$gpu" "$base_fg"
[[ $mem =~ ^[0-9]+$ ]] && printf ' %s' "$(human "$mem")"
printf ' '
