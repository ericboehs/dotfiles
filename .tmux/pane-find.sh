#!/usr/bin/env bash
# Fuzzy pane finder: an expanded prefix+s tree. The query filters the
# windows/panes; every session heading stays put so the shape never moves.
# ctrl-/ switches from matching titles to grepping what each pane is showing.
# Bound to prefix + F in ~/.tmux.conf.
set -uo pipefail
export LC_ALL=${LC_ALL:-en_US.UTF-8}

self=${BASH_SOURCE[0]}
SCROLLBACK=500   # lines of history per pane searched in content mode

# target \t session \t win_index \t win_name \t pane_index \t pane_title \t panes_in_win \t zoomed \t is_current
FMT='#{session_name}:#{window_index}.#{pane_index}	#{session_name}	#{window_index}	#{window_name}	#{pane_index}	#{pane_title}	#{window_panes}	#{?window_zoomed_flag,Z,}	#{?#{&&:#{pane_active},#{window_active}},*,}'

# Snapshot every pane's text as "target<TAB>line". Slow enough (one capture per
# pane) to be worth caching for the life of the popup; ctrl-r re-takes it.
build_content_cache() {
  [ -s "$PANEFIND_DIR/content" ] && return 0
  local t
  while read -r t; do
    tmux capture-pane -p -S "-$SCROLLBACK" -t "$t" 2>/dev/null |
      grep -v '^[[:space:]]*$' | cut -c1-300 | awk -v t="$t" '{print t "\t" $0}'
  done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}') \
    > "$PANEFIND_DIR/content"
}

render_tree() {
  local query=${1-} mode list keep
  mode=$(cat "$PANEFIND_DIR/mode" 2>/dev/null || echo title)
  list=$(tmux list-panes -a -F "$FMT") || return 0

  if [ -z "$query" ]; then
    keep=$list
  else
    # fzf does the fuzzy matching over "session window-name pane-title"; the
    # winners are then re-projected onto the original tree order.
    keep=$(printf '%s\n' "$list" |
      fzf --filter="$query" --delimiter=$'\t' --with-nth=2,4,6 2>/dev/null)
    if [ "$mode" = content ]; then
      build_content_cache
      # --filter output is score-sorted, so the first hit per pane is its best
      # matching line; keep it as the excerpt shown beside the title.
      keep=$(printf '%s\n' "$keep"
             fzf --filter="$query" --exact --delimiter=$'\t' --with-nth=2 \
                 < "$PANEFIND_DIR/content" 2>/dev/null |
               awk -F'\t' '!seen[$1]++ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
                                         print $1 "\t" substr($2, 1, 70) }')
    fi
  fi

  awk -F'\t' -v filtering="${query:+1}" '
    NR==FNR { if ($1 != "") { keep[$1]=1; if (NF == 2 && !($1 in exc)) exc[$1]=$2 } next }
    {
      n=NR-off; row[n]=$0; tgt[n]=$1; sess[n]=$2; win[n]=$2":"$3
      total[$2]++
      if ($1 in keep) {
        kept[n]=1; shown[$2]++; winkept[win[n]]++
        lastwin[win[n]]=n; lastsess[$2]=n
      }
    }
    END {
      D="\033[2m"; B="\033[1m"; C="\033[36m"; Y="\033[33m"; R="\033[0m"
      for (i=1; i<=n; i++) {
        split(row[i], f, "\t")
        if (sess[i] != sess[i-1]) {
          hits = shown[sess[i]] + 0
          count = filtering ? hits "/" total[sess[i]] : total[sess[i]]
          head = (filtering && hits == 0) ? D : B C
          printf "%s\t%s%s%s %s(%s)%s\n", sess[i], head, sess[i], R, D, count, R
        }
        if (!kept[i]) continue
        zoom = (f[8]=="Z") ? " " Y "[Z]" R : ""
        here = (f[9]=="*") ? C " \xe2\x86\x90" R : ""
        tail = (tgt[i] in exc) ? D "  \xe2\x9f\xa9 " exc[tgt[i]] R : ""
        wlast = (lastwin[win[i]] == lastsess[sess[i]])
        wglyph = wlast ? "\xe2\x94\x94\xe2\x94\x80" : "\xe2\x94\x9c\xe2\x94\x80"
        if (winkept[win[i]] == 1) {
          printf "%s\t%s%s %-3s%s %s%s%s%s\n", tgt[i], D, wglyph, f[3], R, f[6], zoom, here, tail
        } else {
          if (win[i] != win[i-1])
            printf "%s:%s\t%s%s %-3s%s %s%s\n", f[2], f[3], D, wglyph, f[3], R, f[4], zoom
          plast = (i == lastwin[win[i]])
          pglyph = plast ? "\xe2\x94\x94\xe2\x94\x80" : "\xe2\x94\x9c\xe2\x94\x80"
          bar = wlast ? "   " : "\xe2\x94\x82  "
          printf "%s\t%s%s%s %s%s%s%s%s\n", tgt[i], D, bar, pglyph, R, f[6], zoom, here, tail
        }
      }
    }
  ' <(printf '%s\n' "$keep") <(printf '%s\n' "$list")
}

# Rebuild the list fzf reads from. Positioning is left to the load event below:
# pos() has to run after the new list is in, not alongside the reload.
emit_actions() {
  render_tree "${1-}" > "$PANEFIND_DIR/list"
  printf 'reload(cat %s)' "$PANEFIND_DIR/list"
}

case ${1-} in
  --refresh)                       # every keystroke
    emit_actions "${2-}"; exit 0 ;;
  --pos)                           # after each load: park on the first match,
    pos=$(awk -F'\t' '$1 ~ /:/ {print NR; exit}' "$PANEFIND_DIR/list" 2>/dev/null)
    printf 'pos(%d)' "${pos:-1}"; exit 0 ;;   # never on a session heading
  --toggle)                        # ctrl-/ : titles <-> pane contents
    if [ "$(cat "$PANEFIND_DIR/mode" 2>/dev/null)" = content ]; then
      echo title > "$PANEFIND_DIR/mode"; prompt='find pane> '
    else
      echo content > "$PANEFIND_DIR/mode"; prompt='grep panes> '
    fi
    emit_actions "${2-}"; printf '+change-prompt(%s)' "$prompt"; exit 0 ;;
  --rescan)                        # ctrl-r : re-snapshot pane contents
    : > "$PANEFIND_DIR/content"; emit_actions "${2-}"; exit 0 ;;
  --tree)
    render_tree "${2-}"; exit 0 ;;
esac

PANEFIND_DIR=$(mktemp -d -t panefind)
export PANEFIND_DIR
trap 'rm -rf "$PANEFIND_DIR"' EXIT
echo title > "$PANEFIND_DIR/mode"

q=$(printf '%q' "$self")
render_tree > "$PANEFIND_DIR/list"
target=$(
  fzf --ansi --disabled --sync --delimiter=$'\t' --with-nth=2 \
    --bind "start:reload(cat $PANEFIND_DIR/list)" \
    --prompt='find pane> ' --info=inline --reverse --no-sort \
    --header='ctrl-/ search pane contents · ctrl-r rescan' \
    --bind "load:transform:$q --pos" \
    --bind "change:transform:$q --refresh {q}" \
    --bind "ctrl-/:transform:$q --toggle {q}" \
    --bind "ctrl-r:transform:$q --rescan {q}" \
    --preview="tmux capture-pane -pe -t {1}" \
    --preview-window=right,55%,border-left \
    < /dev/null \
  | cut -f1
) || exit 0

[ -n "$target" ] || exit 0
case $target in
  *.*) tmux switch-client -t "${target%.*}" \; select-pane -t "$target" ;;
  *)   tmux switch-client -t "$target" ;;
esac
