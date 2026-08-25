# Inlined `brew shellenv` to avoid forking the brew binary (~115ms cold).
# If Homebrew moves or you change prefix, run `brew shellenv` and update.
export HOMEBREW_PREFIX="/opt/homebrew"
export HOMEBREW_CELLAR="/opt/homebrew/Cellar"
export HOMEBREW_REPOSITORY="/opt/homebrew"
fpath[1,0]="/opt/homebrew/share/zsh/site-functions"
export FPATH
[ -x /usr/libexec/path_helper ] && eval "$(/usr/bin/env PATH_HELPER_ROOT="/opt/homebrew" /usr/libexec/path_helper -s)"
[ -z "${MANPATH-}" ] || export MANPATH=":${MANPATH#:}"
export INFOPATH="/opt/homebrew/share/info:${INFOPATH:-}"

# path_helper — the call above and the one /etc/zprofile already made — does not
# extend PATH, it rebuilds it: /etc/paths then /etc/paths.d go in front and
# whatever .zshenv had set is appended behind them. Login shells therefore got
# /opt/homebrew/bin ahead of the mise shims and ~/bin, so ruby, node, python,
# uv, nvim and ~70 others resolved to Homebrew while `zsh -c` resolved them to
# mise. This never bit us while path.zsh was sourced from .zshrc, because that
# runs after zprofile; moving it to .zshenv moved it in front of path_helper.
#
# Re-run .zshenv to put the front of PATH back. It is the same one list, so the
# ordering cannot drift from the non-login case, and `typeset -Ug path` in
# path.zsh makes the replay idempotent: each entry keeps its leftmost position
# and the copies path_helper stranded further down are dropped.
source "$HOME/.zshenv"
