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

# Local overrides
[[ -f "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"
