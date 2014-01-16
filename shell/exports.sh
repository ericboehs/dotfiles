# Set default editor (for git and many other binaries)
export EDITOR='vim'

# Set PAGER and MANPAGER to vim
export MANPAGER="sh -c \"col -bx | vim -c 'set ft=man nolist' -MR -\""
export PAGER='/usr/share/vim/vim*/macros/less.sh'

# Add 256 color support for your TERM
export TERM=screen-256color

# Turn on colors for commands like `ls`
export CLICOLOR=1

# Set Python Path
export PYTHONPATH="$HOME/.local/lib/python"

# TODO: Remove old configs that you don't use anymore
# Set current working directory for tmux prompt (powerline)
#export PS1="$PS1"'$([ -n "$TMUX" ] && tmux setenv TMUXPWD_$(tmux display -p "#D" | tr -d %) "$PWD")'

export NODE_PATH="/usr/local/lib/node_modules"

# For Android emulator from homebrew
export ANDROID_HOME=/usr/local/opt/android-sdk

#export PAGER=less

# Shaves about ~1s off Rails boot time
export RUBY_GC_HEAP_INIT_SLOTS=1000000
export RUBY_HEAP_SLOTS_INCREMENT=1000000
export RUBY_HEAP_SLOTS_GROWTH_FACTOR=1
export RUBY_GC_MALLOC_LIMIT=1000000000
export RUBY_HEAP_FREE_MIN=500000
