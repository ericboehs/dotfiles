#!/usr/bin/env bash
# Launch btop with the Catppuccin flavour matching macOS appearance.
# btop only reads its theme from the config file (there is no --theme flag),
# so rewrite color_theme before exec. Mirrors the detection in theme-sync.sh.

if defaults read -g AppleInterfaceStyle 2>/dev/null | grep -q Dark; then
  theme=catppuccin_mocha
else
  theme=catppuccin_latte
fi

conf="$HOME/.config/btop/btop.conf"
[ -f "$conf" ] && sed -i '' "s|^color_theme = .*|color_theme = \"$theme\"|" "$conf"

exec btop "$@"
