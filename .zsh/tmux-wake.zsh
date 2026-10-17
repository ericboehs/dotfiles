# Nudge tmux's status daemon (~/.tmux/status-daemon.sh) whenever a command
# starts, so a background window running a shell job dims its index at once
# instead of at the daemon's next scheduled sweep (up to 15s when idle).
#
# No process is spawned: sysopen/syswrite are zsh/system builtins, and the
# write lands on the daemon's private FIFO. Every exec on the VA Mac is audited
# and scanned, so a fork per command would cost more than the dimming is worth.
#
# O_NONBLOCK matters: if the daemon was kill -9'd its FIFO survives without a
# reader, and a blocking open would hang every command. Non-blocking, the open
# just fails (ENXIO) and the hook does nothing.

[[ -n $TMUX ]] || return 0
zmodload -F zsh/system b:sysopen b:syswrite 2>/dev/null || return 0

() {
  # $TMUX is "socket,server_pid,session"; the daemon keys its run dir the same way.
  local server_pid=${${TMUX#*,}%%,*}
  [[ $server_pid == <-> ]] || return 0
  typeset -g _tmux_wake_fifo=${${TMPDIR:-/tmp}%/}/tmux-status-daemon.$EUID.$server_pid/tick
}
[[ -n $_tmux_wake_fifo ]] || return 0

_tmux_wake() {
  [[ -p $_tmux_wake_fifo ]] || return 0
  local fd
  sysopen -w -o nonblock -u fd $_tmux_wake_fifo 2>/dev/null || return 0
  syswrite -o $fd $'w\n' 2>/dev/null
  exec {fd}>&-
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _tmux_wake
