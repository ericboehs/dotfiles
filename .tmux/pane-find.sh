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

# Snapshot every pane as "target<TAB>line-number<TAB>text". The line number is
# from the unfiltered capture so it still addresses the pane once the blank
# lines are dropped — that is what lets the preview scroll to the hit.
build_content_cache() {
  [ -s "$PANEFIND_DIR/content" ] && return 0
  local t
  while read -r t; do
    tmux capture-pane -p -S "-$SCROLLBACK" -t "$t" 2>/dev/null |
      cut -c1-300 | awk -v t="$t" 'NF { print t "\t" NR "\t" $0 }'
  done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}') \
    > "$PANEFIND_DIR/content"
}

# Paint the query in the same colors copy-mode uses for a search hit, which
# theme-sync.sh republishes as @match_bg/@match_fg on every light/dark flip.
# Not reverse video: fzf's ANSI parser drops both \e[27m and \e[0m mid-line, so
# a reverse highlight bleeds to the end of the row. An explicit color pair
# closed with \e[39;49m it does honour.
highlight() {
  local query=${1-} bg fg
  [ -n "$query" ] || { cat; return; }

  bg=$(tmux show-options -gqv @match_bg 2>/dev/null)
  fg=$(tmux show-options -gqv @match_fg 2>/dev/null)
  if [[ $bg =~ ^#[0-9a-fA-F]{6}$ && $fg =~ ^#[0-9a-fA-F]{6}$ ]]; then
    HL_START=$(printf '\033[38;2;%d;%d;%dm\033[48;2;%d;%d;%dm' \
      $((16#${fg:1:2})) $((16#${fg:3:2})) $((16#${fg:5:2})) \
      $((16#${bg:1:2})) $((16#${bg:3:2})) $((16#${bg:5:2})))
  else
    HL_START=$(printf '\033[30;43m')   # theme-sync has not run yet
  fi

  HL_START=$HL_START perl -pe '
    BEGIN { $q = shift; $s = $ENV{HL_START} }
    s/(\Q$q\E)/$s$1\e[39;49m/gi' -- "$query"
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
      # Exact, not fuzzy: fuzzy over raw pane text matches nearly everything.
      # --filter output is score-sorted, so the first hit per pane is its best
      # line; it becomes both the excerpt and the preview's scroll target.
      keep=$(printf '%s\n' "$keep"
             fzf --filter="$query" --exact --delimiter=$'\t' --with-nth=3 \
                 < "$PANEFIND_DIR/content" 2>/dev/null |
               awk -F'\t' '!seen[$1]++ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3)
                                         print $1 "\t" substr($3, 1, 70) "\t" $2 }')
    fi
  fi

  # Emits "target \t display \t preview-line" per row; fzf shows only field 2.
  awk -F'\t' -v filtering="${query:+1}" '
    NR==FNR { if ($1 != "") { keep[$1]=1
                              if (NF == 3 && !($1 in exc)) { exc[$1]=$2; mline[$1]=$3 } }
              next }
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
          printf "%s\t%s%s%s %s(%s)%s\t0\n", sess[i], head, sess[i], R, D, count, R
        }
        if (!kept[i]) continue
        zoom = (f[8]=="Z") ? " " Y "[Z]" R : ""
        here = (f[9]=="*") ? C " \xe2\x86\x90" R : ""
        tail = (tgt[i] in exc) ? D "  \xe2\x9f\xa9 " exc[tgt[i]] R : ""
        ml   = (tgt[i] in mline) ? mline[tgt[i]] : 0
        wlast = (lastwin[win[i]] == lastsess[sess[i]])
        wglyph = wlast ? "\xe2\x94\x94\xe2\x94\x80" : "\xe2\x94\x9c\xe2\x94\x80"
        if (winkept[win[i]] == 1) {
          printf "%s\t%s%s %-3s%s %s%s%s%s\t%s\n", tgt[i], D, wglyph, f[3], R, f[6], zoom, here, tail, ml
        } else {
          if (win[i] != win[i-1])
            printf "%s:%s\t%s%s %-3s%s %s%s\t0\n", f[2], f[3], D, wglyph, f[3], R, f[4], zoom
          plast = (i == lastwin[win[i]])
          pglyph = plast ? "\xe2\x94\x94\xe2\x94\x80" : "\xe2\x94\x9c\xe2\x94\x80"
          bar = wlast ? "   " : "\xe2\x94\x82  "
          printf "%s\t%s%s%s %s%s%s%s%s\t%s\n", tgt[i], D, bar, pglyph, R, f[6], zoom, here, tail, ml
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
  --preview)                       # target, hit line (0 = none), query
    t=${2-}; ml=${3:-0}; q=${4-}
    if [ "${ml:-0}" -gt 0 ]; then  # open on the hit with a few lines of lead-in
      tmux capture-pane -pe -S "-$SCROLLBACK" -t "$t" 2>/dev/null |
        awk -v s=$(( ml > 8 ? ml - 8 : 1 )) 'NR >= s'
    else
      tmux capture-pane -pe -t "$t" 2>/dev/null
    fi | highlight "$q"
    exit 0 ;;
  --tree)
    render_tree "${2-}"; exit 0 ;;
esac

PANEFIND_DIR=$(mktemp -d -t panefind)
export PANEFIND_DIR
trap 'rm -rf "$PANEFIND_DIR"' EXIT
echo title > "$PANEFIND_DIR/mode"

q=$(printf '%q' "$self")
# Popups inherit whatever FZF_DEFAULT_OPTS the server froze at start, which goes
# stale the first time the appearance flips; theme-sync keeps @fzf_colors true.
IFS=' ' read -ra colors <<< "$(tmux show-options -gqv @fzf_colors)"

render_tree > "$PANEFIND_DIR/list"
target=$(
  fzf ${colors[@]+"${colors[@]}"} --ansi --disabled --sync --delimiter=$'\t' --with-nth=2 \
    --prompt='find pane> ' --info=inline --reverse --no-sort \
    --header='ctrl-/ search pane contents · ctrl-r rescan' \
    --bind "start:reload(cat $PANEFIND_DIR/list)" \
    --bind "load:transform:$q --pos" \
    --bind "change:transform:$q --refresh {q}" \
    --bind "ctrl-/:transform:$q --toggle {q}" \
    --bind "ctrl-r:transform:$q --rescan {q}" \
    --preview="$q --preview {1} {3} {q}" \
    --preview-window=right,55%,border-left \
    < /dev/null \
  | cut -f1
) || exit 0

[ -n "$target" ] || exit 0
case $target in
  *.*) tmux switch-client -t "${target%.*}" \; select-pane -t "$target" ;;
  *)   tmux switch-client -t "$target" ;;
esac
