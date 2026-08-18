source "$HOME/.zsh/p10k-preload.zsh"

# Options & env
autoload -Uz compinit; compinit -C
setopt interactivecomments autocd extendedglob
export CLICOLOR=1 EDITOR=nvim

# Plugins (load before config so autosuggestions defaults are set before
# abbreviations.zsh appends to ZSH_AUTOSUGGEST_CLEAR_WIDGETS)
source "$HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
source "$HOME/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh"
source "$HOME/.zsh/auto-notify.plugin.zsh"

# Source config
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/fzf.zsh"
source "$HOME/.zsh/functions.zsh"

# Tools
source "$HOME/.zsh/tools.zsh"

# Prompt
source "$HOME/.zsh/p10k.zsh"

# Local overrides. Spelled as `if` rather than `[[ … ]] && source …` because
# the && form leaves $? = 1 when the file is absent, and this is the last
# statement in .zshrc — so p10k painted the very first prompt's ❯ red on every
# machine that has no .zshrc.local.
if [[ -f "$HOME/.zshrc.local" ]]; then
  source "$HOME/.zshrc.local"
fi

# Claude notifications from a machine you are only ever ssh'd into come back to
# whichever machine you are sitting at, and need to name the pane holding that
# ssh so clicking one can land on it. LC_* is the only namespace ssh forwards by
# default (SendEnv LANG LC_* against sshd's matching AcceptEnv), and a %pane_id
# survives every rename and renumbering, so that is what travels.
#
# Which half runs depends on which end of the connection this shell is: the far
# end records where the login came from, keyed by tty, because a tmux session
# there outlives any one connection and cannot rely on its own environment.
if [[ -n $SSH_TTY && -n $LC_CLAUDE_PANE ]]; then
  mkdir -p ~/.claude/origin && print -r -- $LC_CLAUDE_PANE > ~/.claude/origin/${SSH_TTY//\//-}
elif [[ -n $TMUX_PANE ]]; then
  export LC_CLAUDE_PANE=$TMUX_PANE
fi
