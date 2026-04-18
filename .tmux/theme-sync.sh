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
else
  # Catppuccin Latte
  tmux set-option -gq status-style "bg=default,fg=#4c4f69"
  tmux set-option -gq pane-border-style "fg=#ccd0da"
  tmux set-option -gq pane-active-border-style "fg=#04a5e5"
  tmux set-option -gq @active_fg "#04a5e5"
  tmux set-option -gq @time_fg "#8c8fa1"
fi
