autoload -Uz compinit; compinit # Expand directory path shorthand (e.g. cd Co/eri/tm/cach/a<Tab>)
setopt interactivecomments      # Allow comments after commands
setopt autocd                   # cd to directories without typing cd
setopt extendedglob             # Expand file expression (e.g. **/file)
# setopt no_beep                  # No more bells!

export CLICOLOR=1 # Enable color in some commands (e.g. ls)
export EDITOR=nvim

source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/pure.zsh"
source "$HOME/.zsh/asdf.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
source "$HOME/.zsh/fzf.zsh"
source "$HOME/.zsh/auto-notify.plugin.zsh"

# Inlcude a private/local zshrc for ENV secrets and customizations
[[ -f "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"

# heroku autocomplete setup
# HEROKU_AC_ZSH_SETUP_PATH=/Users/ericboehs/Library/Caches/heroku/autocomplete/zsh_setup && test -f $HEROKU_AC_ZSH_SETUP_PATH && source $HEROKU_AC_ZSH_SETUP_PATH;

# TODO: Move these; and make them work:
opsi() {
  eval $(op signin)
  sed -i '' '/export OP_SESSION_my/d' ~/.zshrc.local
  env | grep OP_SESSION_my | sed -e 's/^/export /' >> ~/.zshrc.local
}

mfa() {
  source ~/Code/department-of-veterans-affairs/devops/utilities/issue_mfa.sh Eric.Boehs $1
  sed -i '' '/export AWS_/d' ~/.zshrc.local
  env | grep AWS_ | sed -e 's/^/export /' >> ~/.zshrc.local
}

# export PATH="$HOME/.yarn/bin:$HOME/.config/yarn/global/node_modules/.bin:$PATH"

# Include aliases for github copilot cli
eval "$(github-copilot-cli alias -- "$0")"
