# Resolve light/dark once per shell, cache it, and forward it to remote hosts.
#
# `bin/appearance` holds the actual precedence rules; this file is the half that
# only a login shell can do. Two jobs:
#
#   1. Cache the answer in ~/.cache/dark-mode, which is where anything running
#      outside a login shell reads it — fzf.zsh's popups and .tmux/theme-sync.sh
#      on a Linux box, neither of which can ask the system itself.
#
#   2. Export LC_APPEARANCE, which is how the answer crosses an SSH hop at all.
#      Both ends already pass LC_* through untouched (macOS ships `SendEnv LANG
#      LC_*` under Host *, Debian's sshd `AcceptEnv LANG LC_*`), so neither ssh
#      config has to learn about this. It is a smuggling channel rather than a
#      real locale category — the price of not editing sshd on every box.
#
# Synchronous, unlike the background refresh this replaced: an exported value
# has to be right before the shell's first `ssh`, not eventually.
#
# Skip the fork when a parent already exported LC_APPEARANCE (tmux pane, nested
# zsh, SSH hop). On Darwin, call `defaults` directly instead of bin/appearance:
# that wrapper is bash + `command -v` + `defaults` + `grep`, ~23ms, vs one
# `defaults` at ~8–10ms. Linux still uses the script (no defaults(1)).
if [[ -z $LC_APPEARANCE ]]; then
  if [[ "$OSTYPE" == darwin* ]]; then
    if [[ "$(/usr/bin/defaults read -g AppleInterfaceStyle 2>/dev/null)" == Dark ]]; then
      export LC_APPEARANCE=dark
    else
      export LC_APPEARANCE=light
    fi
  else
    export LC_APPEARANCE=$(~/bin/appearance)
  fi
else
  export LC_APPEARANCE
fi

# Atomic write, so a reader never catches the file mid-update. Skip when the
# cache already matches — tmux panes inherit LC_APPEARANCE and would otherwise
# rewrite the same byte every split.
if [[ ! -r ~/.cache/dark-mode || "$(< ~/.cache/dark-mode)" != "$LC_APPEARANCE" ]]; then
  print -r -- $LC_APPEARANCE > ~/.cache/dark-mode.$$ &&
    mv ~/.cache/dark-mode.$$ ~/.cache/dark-mode
fi
