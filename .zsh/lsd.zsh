# Catppuccin lsd theme, picked per macOS appearance on each prompt.
# Flips ~/.config/lsd/colors.yaml between light/dark; lsd auto-loads it.
_lsd_theme_sync() {
  local target
  if defaults read -g AppleInterfaceStyle 2>/dev/null | grep -q Dark; then
    target="$HOME/.config/lsd/colors-dark.yaml"
  else
    target="$HOME/.config/lsd/colors-light.yaml"
  fi
  [[ "$(readlink "$HOME/.config/lsd/colors.yaml" 2>/dev/null)" != "$target" ]] && \
    ln -sfn "$target" "$HOME/.config/lsd/colors.yaml"
}
_lsd_theme_sync
autoload -Uz add-zsh-hook
add-zsh-hook precmd _lsd_theme_sync
