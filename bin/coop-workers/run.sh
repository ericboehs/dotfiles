#!/bin/bash
# run.sh NAME WORKTREE MODEL: runs ~/coop-workers/NAME.md in WORKTREE with MODEL, logging to
# NAME.jsonl (stderr NAME.err) and the exit code to NAME.exit. MODEL is a pi model (provider/id),
# or cursor[:MODEL_ID] for cursor-agent (default claude-opus-5-5-high).
name=$1 wt=$2 model=${3:-xai/grok-4.7}
d=~/coop-workers
cd "$wt" || exit 1
rm -f "$d/$name.exit"
export PATH=$HOME/.local/bin:$PATH
case $model in
  cursor|cursor:*)
    id=${model#cursor}; id=${id#:}
    cursor-agent -p --trust --force --output-format stream-json --model "${id:-claude-opus-5-5-high}" \
      "$(cat "$d/$name.md")" > "$d/$name.jsonl" 2> "$d/$name.err" ;;
  *)
    pi -p --no-session --no-extensions --model "$model" --thinking high --mode json \
      "$(cat "$d/$name.md")" > "$d/$name.jsonl" 2> "$d/$name.err" ;;
esac
echo $? > "$d/$name.exit"
