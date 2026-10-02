#!/usr/bin/env bash
# Toggle the bright needs-attention index on the window at TARGET.
#
# Usage: mark-window.sh TARGET
#
# TARGET is a full session:window range, i.e. #{mouse_status_range} from the
# status bar binding in ~/.tmux.conf: SESSION:INDEX. Opt-clicking a window
# index calls this. The index turns bold in the attention color, exactly as it
# does when an agent's turn settles or a blocking prompt is waiting, and you
# stay on the window you are looking at. Click it again to take the mark back.
#
# The mark is the same @special_activity window option the pi extension sets,
# so the status format needs no second case for it, and the pane-focus-in hook
# in ~/.tmux.conf already clears it: a mark never outlives the reason for it.
#
# Silent on purpose. The click does not move the client, so a display-message
# was the only thing saying the click landed; the index turning bold says it
# louder, and a message appearing in the status of a session you are not even
# looking at is its own distraction.

set -euo pipefail

target=${1:?usage: mark-window.sh SESSION:INDEX}

# Resolve the index to a window id before touching anything. Two reasons.
#
# The space after the last window's index belongs to the *next* window's range,
# and that index does not exist yet — renumber-windows keeps the highest index
# equal to the window count — so there is nothing there to mark. And a window
# can close between the click and this script, making the index name a different
# window by the time it is read. Pinned to a window id, every later command
# names one window even if the status row shifts underneath.
#
# Both checks have to be explicit. `list-windows -t $sess:9` errors on a missing
# index but lists the whole session when the index exists, and
# `display-message -t $sess:9` does not error at all — it answers with some
# other window in the session, which would light up an index nobody clicked.
session=${target%:*}
index=${target##*:}

window=$(tmux list-windows -t "$session" -F '#{window_index} #{window_id}' 2>/dev/null |
  awk -v i="$index" '$1 == i { print $2; exit }') || exit 0
[ -n "$window" ] || exit 0

# show-window-options has no -q in tmux 3.7; show-options -w does, and reports a
# window option that was never set as empty rather than as an error.
if [ "$(tmux show-options -w -t "$window" -qv @special_activity)" = on ]; then
  tmux set-window-option -u -t "$window" @special_activity
else
  tmux set-window-option -t "$window" @special_activity on
fi
