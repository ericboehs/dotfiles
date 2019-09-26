autoload -U compinit; compinit # Expand directory path shorthand (e.g. cd Co/eri/tm/cach/a<Tab>)

setopt interactivecomments # Allow comments after commands
setopt autocd              # cd to directories without typing cd
setopt extendedglob        # Expand file expressiong (e.g. **/file)
setopt no_beep             # No more bells!

export CLICOLOR=1 # Enable color in some commands (e.g. ls)
export EDITOR=vim

source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/pure.zsh"
source "$HOME/.asdf/asdf.sh"
source "$HOME/.asdf/completions/asdf.bash"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/completion.zsh"
source "$HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
source "$HOME/.zsh/fzf.zsh"

# Inlcude a private/local zshrc for ENV secrets and customizations
[[ -f "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"

# heroku autocomplete setup
HEROKU_AC_ZSH_SETUP_PATH=/Users/ericboehs/Library/Caches/heroku/autocomplete/zsh_setup && test -f $HEROKU_AC_ZSH_SETUP_PATH && source $HEROKU_AC_ZSH_SETUP_PATH;

# heroku autocomplete setup
HEROKU_AC_ZSH_SETUP_PATH=/Users/ericboehs/Library/Caches/heroku/autocomplete/zsh_setup && test -f $HEROKU_AC_ZSH_SETUP_PATH && source $HEROKU_AC_ZSH_SETUP_PATH;