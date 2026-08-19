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
# has to be right before the shell's first `ssh`, not eventually. The `defaults`
# call it costs runs only on macOS, at ~9ms.
export LC_APPEARANCE=$(~/bin/appearance)

# Atomic write, so a reader never catches the file mid-update.
print -r -- $LC_APPEARANCE > ~/.cache/dark-mode.$$ &&
  mv ~/.cache/dark-mode.$$ ~/.cache/dark-mode
