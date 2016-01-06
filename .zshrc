# Add pure prompt. https://github.com/sindresorhus/pure
fpath=( "$HOME/.zsh/functions" $fpath )
autoload -U promptinit && promptinit
prompt pure

autoload -U compinit
compinit

setopt interactivecomments # Allow comments after commands
setopt autocd              # cd to paths by just typing the path
setopt extendedglob        # Expand file expressiong (e.g. **/file)
setopt NO_BEEP             # No more bells!

export CLICOLOR=1
export EDITOR=vim
export PAGER='less -q'

source "$HOME/.zsh/completion.zsh"
source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/vi-mode.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"

# Enable autosuggestions
# source "$HOME/.zsh/autosuggestions.zsh"

# Add aliases and abbreviations
source "$HOME/.zsh/abbreviations.zsh"

# Add fzf.zsh. https://github.com/junegunn/fzf
source "$HOME/.zsh/fzf.zsh"
