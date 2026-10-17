# Nudge tmux's status daemon (~/.tmux/status-daemon.sh) whenever a command
# starts or finishes, so a background window running a shell job dims its index
# at once, and brightens the moment the job ends, instead of waiting for the
# daemon's next scheduled sweep (up to 15s when idle).
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

# Starting a command wakes the daemon so the window dims; finishing one wakes
# it again so the daemon sees the pane go idle and brightens the window
# (@job_done) instead of waiting for its next 5s sweep.
#
# The finish wake is skipped for commands under a quarter second: the start
# wake's sweep runs ~0.3s in, so anything quicker was never seen busy and has
# nothing to announce. That keeps ls/cd/git status at one wake, not two. An
# empty Enter runs no preexec, so it sends nothing at all.
zmodload -F zsh/datetime p:EPOCHREALTIME 2>/dev/null
typeset -g _tmux_wake_started=

_tmux_wake_preexec() {
  _tmux_wake_started=$EPOCHREALTIME
  _tmux_wake
}

_tmux_wake_precmd() {
  [[ -n $_tmux_wake_started ]] || return 0
  local started=$_tmux_wake_started
  _tmux_wake_started=
  (( EPOCHREALTIME - started >= 0.25 )) && _tmux_wake
  return 0
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _tmux_wake_preexec
add-zsh-hook precmd _tmux_wake_precmd
