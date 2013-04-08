# Set default editor (for git and many other binaries)
export EDITOR='vim'

# Add 256 color support for your TERM
export TERM=screen-256color

# Turn on colors for commands like `ls`
export CLICOLOR=1

## Set PATH
# Add Homebrew to path
export PATH="/usr/local/bin:$PATH"
# Add Heroku to the path
export PATH="/usr/local/heroku/bin:$PATH"
# Add current gem path to path; See: https://gist.github.com/ericboehs/5329013
export PATH="$(cd $(which gem)/..;pwd):$PATH"

# Set Python Path
export PYTHONPATH="$HOME/.local/lib/python"

# TODO: Remove old configs that you don't use anymore
# Set current working directory for tmux prompt (powerline)
#export PS1="$PS1"'$([ -n "$TMUX" ] && tmux setenv TMUXPWD_$(tmux display -p "#D" | tr -d %) "$PWD")'

#export NODE_PATH="/usr/local/lib/node_modules"
#export PAGER=less
