#!/bin/bash
# supervise.sh NAME WORKTREE [DONE_FILE]: runs NAME's task (~/coop-workers/NAME.md) down a chain of
# models ($MODELS, space separated), or adopts the run already going in tmux window code:NAME.
#
# Default chain: xai/grok-4.7, then opencode-go/deepseek-v4.1-flash. Others on request through
# MODELS: anthropic/claude-sonnet-5, or cursor (cursor-agent, claude-opus-5-5-high, billed to
# Eric's seat: only when he allows Cursor).
# Never baseten, and never grok through opencode-go (it burned the Go limit): grok is xai/ only.
#
# A model fails when it exits non-zero, finishes without DONE_FILE in the worktree, stalls (its log
# quiet for $STALL s, default 900), or ends on a provider error (pi's last message has stopReason
# "error", though pi exits 0; a run that sits a minute after one is stopped). A busy provider
# ("at capacity", overloaded, rate limit) is retried $RETRIES times (default 2), $RETRY_WAIT s apart
# (default 180); a usage limit or lack of funds moves straight to the next model. Each later model
# is told to pick up what the earlier ones left in the worktree.
# Writes ~/coop-workers/NAME.result: "ok <model>" or "failed"; notes in NAME.supervise.
name=$1 wt=$2 done_file=$3 d=~/coop-workers stall=${STALL:-900}
read -r -a models <<< "${MODELS:-xai/grok-4.7 opencode-go/deepseek-v4.1-flash}"
log() { echo "$(date +%FT%T) $*" >> "$d/$name.supervise"; }
rm -f "$d/$name.result"

# The error pi's last finished message ended with (stopReason "error"), or nothing. Cursor runs
# (stream-json) have no such events and read as no error; their exit code and DONE_FILE decide.
last_error() {
  tail -n 400 "$d/$name.jsonl" 2>/dev/null | python3 -c '
import json, sys
err = ""
for line in sys.stdin:
    try: e = json.loads(line)
    except ValueError: continue
    if e.get("type") != "message_end": continue
    m = e.get("message") or {}
    if m.get("role") != "assistant": continue
    err = (m.get("errorMessage") or "error").replace("\n", " ")[:300] if m.get("stopReason") == "error" else ""
print(err)'
}

stop_run() { # stop_run PID: the run's whole process group
  local g; g=$(ps -o pgid= -p "$1" | tr -d ' ')
  [ -n "$g" ] || return
  kill -TERM -- "-$g" 2>/dev/null; sleep 10; kill -KILL -- "-$g" 2>/dev/null
}

attempt() { # attempt MODEL [PID of a run already going]
  local model=$1 pid=$2
  if [ -z "$pid" ]; then
    setsid ~/coop-workers/run.sh "$name" "$wt" "$model" &
    pid=$!
  fi
  log "watching $model (pid $pid)"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 30
    local age=$(( $(date +%s) - $(stat -c %Y "$d/$name.jsonl" 2>/dev/null || date +%s) ))
    if [ "$age" -gt "$stall" ]; then
      log "$model stalled: no output for ${age}s; stopping it"
      stop_run "$pid"; echo 124 > "$d/$name.exit"; break
    fi
    # pi may retry a provider error itself; a minute after one with nothing new, it won't.
    if [ "$age" -gt 60 ] && [ -n "$(last_error)" ]; then
      log "$model hit a provider error and stopped moving; stopping it"
      stop_run "$pid"; echo 125 > "$d/$name.exit"; break
    fi
  done
  while [ ! -f "$d/$name.exit" ] && kill -0 "$pid" 2>/dev/null; do sleep 5; done
  local code err; code=$(cat "$d/$name.exit" 2>/dev/null || echo "?")
  err=$(last_error)
  log "$model exited $code${err:+ after a provider error: $err}"
  [ -z "$err" ] || return 1
  [ "$code" = 0 ] || return 1
  if [ -n "$done_file" ] && [ ! -f "$wt/$done_file" ]; then log "$model exited 0 without $done_file"; return 1; fi
}

existing=$(tmux list-panes -t "code:=$name" -F '#{pane_pid} #{pane_dead}' 2>/dev/null | awk '$2==0{print $1; exit}')
n=0
for model in "${models[@]}"; do
  if [ "$n" -gt 0 ]; then
    for f in jsonl err exit; do [ -f "$d/$name.$f" ] && mv "$d/$name.$f" "$d/$name.prev$n.$f"; done
    grep -q "a previous attempt" "$d/$name.md" ||
      printf '\n\nNote: a previous attempt by another model stopped before finishing and may have left uncommitted changes in this worktree. Start by reviewing `git status` and `git diff`, keep what is right, fix what is not, and finish the task.\n' >> "$d/$name.md"
    log "moving on to $model"
  fi
  n=$((n + 1))
  if attempt "$model" "$existing"; then echo "ok $model" > "$d/$name.result"; exit 0; fi
  existing=
  for _ in $(seq 1 "${RETRIES:-2}"); do
    err=$(last_error)
    echo "$err" | grep -qiE 'usage limit|insufficient|quota|credit' && break
    echo "$err" | grep -qiE 'capacity|overloaded|try again|rate limit|503|529' || break
    log "$model busy; trying it again in ${RETRY_WAIT:-180}s"
    sleep "${RETRY_WAIT:-180}"
    if attempt "$model"; then echo "ok $model" > "$d/$name.result"; exit 0; fi
  done
done
echo "failed" > "$d/$name.result"
