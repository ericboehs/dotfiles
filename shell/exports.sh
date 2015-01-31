# Set default editor (for git and many other binaries)
export EDITOR='vim'

# Set PAGERs
export PAGER="vim -c ':silent! %sm/\\e.\\{-}m//g' -c 'set ft=diff' -c 'normal gg' -c 'map q :q!<CR>' -c 'Fix' -"
export MANPAGER="sh -c \"col -bx | vim -c 'set ft=man nolist' -c 'map q :q!<CR>' -MR -\""
export GHI_PAGER="less"

# Add 256 color support for your TERM
export TERM=screen-256color

# Turn on colors for commands like `ls`
export CLICOLOR=1

# Set Python Path
export PYTHONPATH="$HOME/.local/lib/python"

export NODE_PATH="/usr/local/lib/node_modules"

# For Android emulator from homebrew
export ANDROID_HOME=/usr/local/opt/android-sdk

# Shaves about ~1s off Rails boot time
export RUBY_GC_HEAP_INIT_SLOTS=1000000
export RUBY_HEAP_SLOTS_INCREMENT=1000000
export RUBY_HEAP_SLOTS_GROWTH_FACTOR=1
export RUBY_GC_MALLOC_LIMIT=1000000000
export RUBY_HEAP_FREE_MIN=500000

# For trello_cli. https://github.com/brettweavnet/trello_cli
export TRELLO_DEVELOPER_PUBLIC_KEY=$(git config --get trello-cli.developer-public-key)
export TRELLO_MEMBER_TOKEN=$(git config --get trello-cli.member-token)
