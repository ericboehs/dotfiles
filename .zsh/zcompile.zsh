# Recompile zsh scripts to wordcode when the source is newer. zsh auto-loads
# foo.zwc alongside foo if the zwc is not older. Runs in the background so a
# stale file only costs the *next* shell.

_zcompile_stale() {
  emulate -L zsh
  local f
  for f in \
    $HOME/.zshrc $HOME/.zshenv $HOME/.zprofile $HOME/.p10k.zsh \
    $HOME/.zsh/*.zsh \
    $HOME/.zsh/auto-notify.plugin.zsh \
    $HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh \
    $HOME/.zsh/fast-syntax-highlighting/fast-highlight \
    $HOME/.zsh/fast-syntax-highlighting/fast-string-highlight \
    $HOME/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh
  do
    [[ -s $f && ( ! -s $f.zwc || $f -nt $f.zwc ) ]] || continue
    zcompile -U -- $f 2>/dev/null
  done
}

_zcompile_stale &!
