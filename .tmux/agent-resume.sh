#!/usr/bin/env bash
# Resume the coding agent that just quit in this pane.
#
# Usage: agent-resume.sh [pane-id]
#        agent-resume.sh --print [pane-id]
#
# After pi exits it prints `To resume this session: pi --session <id>` (and
# `--session-dir` when the session is not in the default profile, e.g. pia).
# This finds that line in the pane's scrollback and types it, which is the
# copy-paste the operator otherwise does by hand.
#
# Claude does not print a resume command. If the banner is missing, the last
# `pi` / `pia` / `claude` typed at a prompt in this pane decides between
# `pi --continue`, `pia --continue`, and `claude --continue`. `--continue` is
# cwd-scoped, so it is a fallback rather than the first choice: another pane
# in the same project can own a newer session than the one that just quit here.
#
# Bound to Prefix+r. run-shell does not export TMUX_PANE, so the binding
# passes #{pane_id}; a manual run inside a pane can omit it.

set -euo pipefail

print_only=false
if [ "${1-}" = --print ]; then
  print_only=true
  shift
fi

pane=${1-${TMUX_PANE-}}
if [ -z "$pane" ]; then
  echo "${0##*/}: no pane id given and TMUX_PANE is unset" >&2
  exit 2
fi

# Pick a resume command out of captured pane text. Printed so --print and the
# send path share one parser; kept in a function so a unit of scrollback can
# be piped through it without talking to tmux.
extract_resume() {
  awk '
    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      return s
    }
    {
      line = $0
      if (match(line, /To resume this session:[[:space:]]+/)) {
        banner = trim(substr(line, RSTART + RLENGTH))
        next
      }
      if (match(line, /Resume this session with:[[:space:]]+/)) {
        banner = trim(substr(line, RSTART + RLENGTH))
        next
      }
      # p10k input line is "❯ cmd"; also accept $ % > so a stripped prompt
      # or a remote shell still counts. The agent has to be the command,
      # not a word later in the line (paths like .../pi-coding-agent).
      if (match(line, /(❯|[%$])[[:space:]]+(pi|pia|claude)([ \t]|$)/)) {
        rest = substr(line, RSTART)
        sub(/^[^[:space:]]+[[:space:]]+/, "", rest)
        split(rest, words, /[[:space:]]+/)
        if (words[1] == "pi" || words[1] == "pia" || words[1] == "claude") {
          typed = words[1]
        }
      }
    }
    END {
      if (banner != "") { print banner; exit }
      if (typed != "") { print typed " --continue"; exit }
    }
  '
}

# Only type into a shell. Sending the command into a live agent or into vim
# would dump it into the TUI / buffer.
cmd=$(tmux display-message -p -t "$pane" '#{pane_current_command}')
case $cmd in
  zsh|bash|fish|sh|nu|ksh|dash) ;;
  *)
    $print_only && { echo "${0##*/}: pane is running $cmd" >&2; exit 1; }
    tmux display-message "agent-resume: pane is running $cmd"
    exit 0
    ;;
esac

# 200 lines is enough to cover the quit banner above a new prompt, and cheap
# against a 500k history-limit. -J joins wrapped lines so a long
# --session-dir path stays one match.
text=$(tmux capture-pane -p -J -t "$pane" -S -200)
resume=$(printf '%s\n' "$text" | extract_resume)

# The banner is whatever the agent printed; only send a command we would
# actually want to run, so a stray match cannot become send-keys input.
case $resume in
  pi|pia|claude|pi\ *|pia\ *|claude\ *) ;;
  *)
    $print_only && { echo "${0##*/}: no agent session to resume" >&2; exit 1; }
    tmux display-message "agent-resume: no agent session to resume"
    exit 0
    ;;
esac

if $print_only; then
  printf '%s\n' "$resume"
  exit 0
fi

# C-u drops anything already typed so a half-pasted resume line is replaced
# rather than concatenated. -l so flags in the command stay literal.
tmux send-keys -t "$pane" C-u
tmux send-keys -t "$pane" -l -- "$resume"
tmux send-keys -t "$pane" Enter
tmux display-message "resuming: $resume"
