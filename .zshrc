autoload -U compinit; compinit # Expand directory path shorthand (e.g. cd Co/eri/tm/cach/a<Tab>)

setopt interactivecomments # Allow comments after commands
setopt autocd              # cd to directories without typing cd
setopt extendedglob        # Expand file expressiong (e.g. **/file)
setopt no_beep             # No more bells!

# export EDITOR=vim

# Allow Ctrl-S and Ctrl-Q to be keybindings in vim
stty -ixon > /dev/null 2>/dev/null

source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/pure.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/completion.zsh"
source "$HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
source "$HOME/.zsh/fzf.zsh"

# Inlcude a private/local zshrc for ENV secrets and customizations
[[ -f "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"
