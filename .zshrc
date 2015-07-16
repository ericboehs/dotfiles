# Add pure prompt. https://github.com/sindresorhus/pure
fpath=( "$HOME/.zsh/functions" $fpath )
autoload -U promptinit && promptinit
prompt pure

autoload -U compinit
compinit

setopt interactivecomments # Allow comments after commands
setopt autocd
setopt extendedglob

export CLICOLOR=1

source "$HOME/.zsh/completion.zsh"
source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"

# Add aliases and abbreviations
source "$HOME/.zsh/abbreviations.zsh"

# Add fzf.zsh. https://github.com/junegunn/fzf
source "$HOME/.zsh/fzf.zsh"
