#!/usr/bin/env bash
# Launch btop with the Catppuccin flavour matching the tmux theme.
# btop only reads its theme from the config file (there is no --theme flag),
# so rewrite color_theme before exec.

# theme-sync.sh already decided light vs dark for this server and recorded it
# in @appearance; read that rather than re-detecting. It keeps btop and the
# status bar in agreement, and it is the only answer available on Linux, where
# `defaults read -g AppleInterfaceStyle` does not exist.
if [ "$(tmux show-options -gqv @appearance)" = dark ]; then
  theme=catppuccin_mocha
else
  theme=catppuccin_latte
fi

# Rewrite via a temp file rather than `sed -i`: the in-place flag takes a
# mandatory suffix argument on BSD sed and refuses one on GNU sed, so no single
# invocation works on both macOS and Linux.
conf="$HOME/.config/btop/btop.conf"
if [ -f "$conf" ]; then
  tmp=$(mktemp "$conf.XXXXXX")
  if sed "s|^color_theme = .*|color_theme = \"$theme\"|" "$conf" > "$tmp"; then
    mv "$tmp" "$conf"
  else
    rm -f "$tmp"
  fi
fi

exec btop "$@"
