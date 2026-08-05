#!/usr/bin/env bash
# Sync tmux theme with macOS system appearance.
# Called on tmux startup and re-evaluated via #() in status-format.

if defaults read -g AppleInterfaceStyle 2>/dev/null | grep -q Dark; then
  # Dark: readable fg on dark bg, but reuse Latte's saturated accents
  tmux set-option -gq status-style "bg=default,fg=white"
  tmux set-option -gq pane-border-style "fg=#191923"
  tmux set-option -gq pane-active-border-style "fg=#04a5e5"
  tmux set-option -gq @active_fg "#04a5e5"
  tmux set-option -gq @time_fg "#8c8fa1"
  tmux set-option -gq @clock_fg "#a6adc8"
  tmux set-option -gq @load_warn_fg "#f9e2af"
  tmux set-option -gq @load_crit_fg "#f38ba8"
else
  # Catppuccin Latte
  tmux set-option -gq status-style "bg=default,fg=#4c4f69"
  tmux set-option -gq pane-border-style "fg=#ccd0da"
  tmux set-option -gq pane-active-border-style "fg=#04a5e5"
  tmux set-option -gq @active_fg "#04a5e5"
  tmux set-option -gq @time_fg "#8c8fa1"
  tmux set-option -gq @clock_fg "#6c6f85"
  tmux set-option -gq @load_warn_fg "#df8e1d"
  tmux set-option -gq @load_crit_fg "#d20f39"
fi
