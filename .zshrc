autoload -U compinit; compinit

setopt interactivecomments # Allow comments after commands
setopt autocd              # cd to paths by just typing the path
setopt extendedglob        # Expand file expressiong (e.g. **/file)
setopt NO_BEEP             # No more bells!

export CLICOLOR=1
export EDITOR=vim
export PAGER='less -q'
export TMUX_TMPDIR=/tmp
export LANG=en_US.UTF-8

source "$HOME/.zsh/pure.zsh"
source "$HOME/.zsh/completion.zsh"
source "$HOME/.zsh/rake-completion.zsh"
source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/vi-mode.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/chruby.zsh"
source "$HOME/.zsh/fzf.zsh"
