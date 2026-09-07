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
# path.zsh is sourced from .zshenv, not here: PATH has to exist for
# non-interactive shells too.
source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/abbreviations.zsh"
# Before fzf.zsh: it colors itself from the ~/.cache/dark-mode this writes.
source "$HOME/.zsh/appearance.zsh"
source "$HOME/.zsh/fzf.zsh"
source "$HOME/.zsh/functions.zsh"

# Tools
source "$HOME/.zsh/tools.zsh"

# Prompt
source "$HOME/.zsh/p10k.zsh"

# Recompile stale .zwc in the background. zsh auto-loads them next start.
source "$HOME/.zsh/zcompile.zsh"

# Local overrides. Spelled as `if` rather than `[[ … ]] && source …` because
# the && form leaves $? = 1 when the file is absent, and this is the last
# statement in .zshrc — so p10k painted the very first prompt's ❯ red on every
# machine that has no .zshrc.local.
if [[ -f "$HOME/.zshrc.local" ]]; then
  source "$HOME/.zshrc.local"
fi

# Coding-agent notifications from a machine you are only ever ssh'd into come
# back to whichever machine you are sitting at, and need to name the pane holding
# that ssh so clicking one can land on it. LC_* is the only namespace ssh
# forwards by default (SendEnv LANG LC_* against sshd's matching AcceptEnv), and
# a %pane_id survives every rename and renumbering, so that is what travels.
#
# Which half runs depends on which end of the connection this shell is: the far
# end records where the login came from, keyed by tty, because a tmux session
# there outlives any one connection and cannot rely on its own environment.
# A login with no pane to declare has to erase the last one's answer, not just
# decline to write: ttys are reused, so /dev/pts/0 keeps whatever some earlier
# connection recorded there. Ssh'ing from a plain terminal tab after once having
# ssh'd from inside tmux left the old pane id standing, and a notification from
# this machine would then send the click to a pane that had nothing to do with
# it - selecting the wrong tab and yanking the local tmux somewhere else.
#
# LC_CLAUDE_PANE and ~/.claude/origin are compatibility mirrors for endpoints
# still running the old name; LC_AGENT_NOTIFY_PANE and ~/.agent-notify/origin are
# canonical.
if [[ -n $SSH_TTY ]]; then
  agent_notify_origin=${LC_AGENT_NOTIFY_PANE:-${LC_CLAUDE_PANE:-}}
  agent_notify_origin_file=${SSH_TTY//\//-}
  mkdir -p ~/.agent-notify/origin ~/.claude/origin
  if [[ -n $agent_notify_origin ]]; then
    print -r -- "$agent_notify_origin" > ~/.agent-notify/origin/$agent_notify_origin_file
    print -r -- "$agent_notify_origin" > ~/.claude/origin/$agent_notify_origin_file
  else
    rm -f ~/.agent-notify/origin/$agent_notify_origin_file \
      ~/.claude/origin/$agent_notify_origin_file
  fi
  unset agent_notify_origin agent_notify_origin_file
elif [[ -n $TMUX_PANE ]]; then
  export LC_AGENT_NOTIFY_PANE=$TMUX_PANE
  export LC_CLAUDE_PANE=$TMUX_PANE
fi

# pi's native binary probes tmux hyperlink support synchronously during boot -
# `tmux display-message` from node, ~10ms warm but up to its 250ms timeout when
# the server is busy, which read as random +300ms boots under load. The answer
# only changes when the outer terminal does, so export the cached answer (pi
# honours PI_HYPERLINKS over its own probe) and let a detached job refresh the
# cache for the next shell. An existing PI_HYPERLINKS wins; the refresh honours
# the PI_NO_HYPERLINKS_REFRESH=1 opt-out, like bin/pi-launch did before macOS
# moved to the native release binary.
if [[ -n $TMUX && -z $PI_HYPERLINKS && -z $PI_NO_HYPERLINKS_REFRESH ]]; then
  pi_hyperlinks_cache=${XDG_CACHE_HOME:-$HOME/.cache}/pi/tmux-hyperlinks
  if [[ -e $pi_hyperlinks_cache ]]; then
    read -r v < "$pi_hyperlinks_cache"
    [[ $v == 0 || $v == 1 ]] && export PI_HYPERLINKS=$v
  fi
  (
    features=$(tmux display-message -p '#{client_termfeatures}' 2>/dev/null) || exit 0
    case ,${features}, in
      *,hyperlinks,*) printf 1 ;;
      *) printf 0 ;;
    esac > "$pi_hyperlinks_cache.tmp" && mv "$pi_hyperlinks_cache.tmp" "$pi_hyperlinks_cache"
  ) &!
  unset pi_hyperlinks_cache v
fi

# V8 caches the compiled form of every module node loads under here — measured
# ~44ms off pi's stock bundle on Linux (no effect on macOS, where the boot is
# dominated by other costs). Harmless for every other node CLI, so export it
# for all interactive shells rather than per-launcher.
if [[ -z $NODE_COMPILE_CACHE && -z $PI_NO_COMPILE_CACHE ]]; then
  export NODE_COMPILE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pi/v8"
fi
