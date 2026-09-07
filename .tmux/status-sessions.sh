#!/usr/bin/env bash
# Build tmux status rows for sessions, ordered by creation time. tmux limits
# the status area to five rows; if there are more than five sessions, the first
# four keep their own rows and the remainder share the fifth.
#
# @status_all_sessions (default 1) shows every session. Set it to 0 to collapse
# to a single row that follows the client's current session. Prefix+S toggles.
#
# Called once while sourcing tmux.conf, from session lifecycle hooks, and from
# the toggle binding. `toggle` flips the option, rebuilds, and announces.

sessions=()
while IFS='|' read -r _created session_id; do
  [ -n "$session_id" ] && sessions+=("$session_id")
done < <(
  tmux list-sessions -F '#{session_created}|#{session_id}' 2>/dev/null |
    sort -t '|' -k1,1n
)

count=${#sessions[@]}
[ "$count" -gt 0 ] || exit 0

show_all=$(tmux show-options -gqv @status_all_sessions 2>/dev/null)
[ -n "$show_all" ] || show_all=1

if [ "${1:-}" = toggle ]; then
  if [ "$show_all" = 0 ]; then
    show_all=1
  else
    show_all=0
  fi
  tmux set-option -gq @status_all_sessions "$show_all"
fi

# Evaluated inside #{S:...}, so the window loop gets the matching session's
# context rather than whichever session the client is currently viewing.
# Window ranges carry an exact session:window target. tmux assigns the first
# character after a new range to the previous range, so each next-window range
# begins before the preceding window's indicator. That makes the indicator its
# right-side hit area and the following space the next window's left-side area.
row="\
#[range=session|#{session_id}]\
#{?#{==:#{session_name},#{client_session}},#[fg=#{E:@active_fg}],#[fg=#{E:@time_fg}]}#S\
#[fg=default]#[norange]\
#{W:\
#{?window_start_flag,#[range=user|#{session_id}:#{window_index}]  , }\
#{?window_zoomed_flag,󰊓 ,}\
#{?#{&&:#{window_active},#{==:#{session_name},#{client_session}}},#[fg=#{E:@active_fg}],#{?#{||:#{@special_activity},#{@job_done}},#[fg=#{E:@attention_fg} bold],#{?#{@agent_count},#[fg=#{E:@dim_fg}],}}}\
#I\
#{?#{&&:#{window_active},#{==:#{session_name},#{client_session}}},,#[fg=default nobold]}\
#{?window_end_flag,#{?#{==:#{session_name},#{client_session}},#[range=user|new-window],#[norange]},#[range=user|#{session_id}:#{next_window_index}]}\
#{?#{window_bell_flag},•, }\
#{?#{&&:#{window_active},#{==:#{session_name},#{client_session}}},#[fg=default],}\
}\
#{?#{==:#{session_name},#{client_session}},#[fg=#{E:@time_fg}] + #[norange],}"

session_format() {
  local session_id=$1
  printf '%s' "#{S:#{?#{==:#{session_id},${session_id}},${row},}}"
}

# These helpers intentionally print nothing. Keeping them on the first physical
# row preserves the existing five-second theme and agent-state refresh cadence.
hidden='#(~/.tmux/theme-sync.sh)#(~/.tmux/agent-sync.sh)'
right="\
#[align=right]#[fg=#{E:@time_fg}]\
#[range=right]#(~/.tmux/gpu.sh)#(~/.tmux/loadavg.sh)#[norange] \
#[fg=#{E:@clock_fg}]#[range=user|clock]%H:%M CT#[norange]#[fg=default]"
separator='#[fg=#{E:@dim_fg}]│#[fg=default] '

formats=('' '' '' '' '')
if [ "$show_all" = 0 ]; then
  # One format, evaluated per client: only the attached session's row shows.
  height=1
  formats[0]="#{S:#{?#{==:#{session_name},#{client_session}},${row},}}"
elif [ "$count" -le 5 ]; then
  height=$count
  i=0
  while [ "$i" -lt "$count" ]; do
    formats[i]=$(session_format "${sessions[i]}")
    i=$((i + 1))
  done
else
  height=5
  i=0
  while [ "$i" -lt 4 ]; do
    formats[i]=$(session_format "${sessions[i]}")
    i=$((i + 1))
  done

  # Native tmux status bars cannot exceed five rows. Preserve access to every
  # extra session by rendering all overflow sessions on the last row.
  while [ "$i" -lt "$count" ]; do
    [ -n "${formats[4]}" ] && formats[4]="${formats[4]}${separator}"
    formats[4]="${formats[4]}$(session_format "${sessions[$i]}")"
    i=$((i + 1))
  done
fi

formats[0]="${hidden}${formats[0]}"
last=$((height - 1))
formats[last]="${formats[last]}${right}"

# Set all five indices so tmux's unused built-in status-format entries cannot
# reappear when the status height later grows.
i=0
while [ "$i" -lt 5 ]; do
  old=$(tmux show-options -gqv "status-format[$i]" 2>/dev/null)
  if [ "$old" != "${formats[$i]}" ]; then
    tmux set-option -gq "status-format[$i]" "${formats[$i]}"
  fi
  i=$((i + 1))
done

# tmux spells a one-row status area "on"; numeric sizes begin at two.
if [ "$height" -eq 1 ]; then
  wanted_status=on
else
  wanted_status=$height
fi
if [ "$(tmux show-options -gqv status 2>/dev/null)" != "$wanted_status" ]; then
  tmux set-option -gq status "$wanted_status"
fi

if [ "${1:-}" = toggle ]; then
  if [ "$show_all" = 0 ]; then
    tmux display-message 'status sessions: current'
  else
    tmux display-message 'status sessions: all'
  fi
fi
