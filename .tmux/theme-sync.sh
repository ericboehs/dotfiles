#!/usr/bin/env bash
# Sync the tmux theme with the system appearance: Catppuccin Latte / Mocha.
# Called on tmux startup and re-evaluated via #() in status-format.
#
# Two deliberate exceptions to the palettes: the accent stays Latte's sky in
# both modes (it reads on either background, so the active window is the same
# color all day), and @time_fg stays Latte's overlay1 for the same reason.

# Detecting inline here used to mean calling `defaults`, which does not exist on
# Linux and failed into the light branch — leaving coop's status bar in Latte
# against a dark terminal no matter what the Mac was set to. bin/appearance
# answers for both platforms; on Linux it reads what the SSH client forwarded.
if [ "$("$HOME/bin/appearance")" = dark ]; then
  mode=dark
  # Mocha
  surface0="#313244"; surface1="#45475a"
  text="#cdd6f4"; status_fg="white"
  border="#191923"
  clock="#a6adc8"
  warn="#f9e2af"; crit="#f38ba8"; peach="#fab387"
  mark="#cba6f7"; mark_fg="#11111b"
else
  mode=light
  # Latte
  surface0="#ccd0da"; surface1="#bcc0cc"
  text="#4c4f69"; status_fg="#4c4f69"
  border="#ccd0da"
  clock="#6c6f85"
  warn="#df8e1d"; crit="#d20f39"; peach="#fe640b"
  mark="#8839ef"; mark_fg="#eff1f5"
fi

# This script runs on every status redraw. Re-applying ~20 options each time is
# pure waste, so bail out unless the appearance actually flipped. Editing the
# colors below? Run `tmux set -gu @appearance` first to force a re-apply.
[ "$(tmux show-options -gqv @appearance)" = "$mode" ] && exit 0
tmux set-option -gq @appearance "$mode"

# Past the guard above means the appearance just flipped, which is exactly once
# per toggle — the right moment to tell the Linux boxes, which cannot see the
# toggle themselves. Fully detached: tmux reads this script's stdout to EOF, so
# a child holding a copy of it would stall the status line for the length of the
# push.
~/bin/appearance-push "$mode" >/dev/null 2>&1 </dev/null &

accent="#04a5e5"   # Latte sky, in both modes
contrast="#11111b" # readable on the accent and on every highlight below

# Status bar and panes
tmux set-option -gq status-style "bg=default,fg=$status_fg"
tmux set-option -gq pane-border-style "fg=$border"
tmux set-option -gq pane-active-border-style "fg=$accent"
tmux set-option -gq @active_fg "$accent"
tmux set-option -gq @time_fg "#8c8fa1"
tmux set-option -gq @clock_fg "$clock"
tmux set-option -gq @load_warn_fg "$warn"
tmux set-option -gq @load_crit_fg "$crit"

# Menus, messages and popups. These default to bg=yellow, which is the stray
# orange that shows up in every menu and prompt on an otherwise themed setup.
tmux set-option -gq mode-style "bg=$accent,fg=$contrast"
tmux set-option -gq message-style "bg=$surface0,fg=$text"
tmux set-option -gq message-command-style "bg=$surface0,fg=$peach"
tmux set-option -gq menu-style "bg=$surface0,fg=$text"
tmux set-option -gq menu-selected-style "bg=$accent,fg=$contrast"
tmux set-option -gq menu-border-style "fg=$surface1"
tmux set-option -gq popup-border-style "fg=$surface1"

# fzf's palette, read from the same file ~/.zsh/fzf.zsh reads so the two cannot
# drift. That file only reaches shells it is sourced in; popups get a copy of
# FZF_DEFAULT_OPTS frozen at server start, so a flip left every popup showing
# Latte on a Mocha terminal. The tmux env fixes popups started from here on;
# @fzf_colors lets one pass it on the command line, which beats an inherited
# FZF_DEFAULT_OPTS outright.
if [ -r "$HOME/.zsh/fzf-colors.$mode" ]; then
  fzf_colors=$(cat "$HOME/.zsh/fzf-colors.$mode")
  tmux set-option -gq @fzf_colors "$fzf_colors"
  tmux set-environment -g FZF_DEFAULT_OPTS "$fzf_colors"
fi

# Search-hit highlight, shared with the prefix+F pane finder's preview.
tmux set-option -gq @match_bg "$warn"
tmux set-option -gq @match_fg "$contrast"

# Copy mode: every match subdued, the current one loud, marks distinct from both.
tmux set-option -gq copy-mode-match-style "bg=$warn,fg=$contrast"
tmux set-option -gq copy-mode-current-match-style "bg=$peach,fg=$contrast"
tmux set-option -gq copy-mode-mark-style "bg=$mark,fg=$mark_fg"

# Prefix+t clock and Prefix+q pane numbers
tmux set-option -gq clock-mode-colour "$accent"
tmux set-option -gq display-panes-colour "#8c8fa1"
tmux set-option -gq display-panes-active-colour "$accent"
