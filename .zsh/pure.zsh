# `brew install pure` first
fpath=( "/opt/homebrew/share/zsh/site-functions" $fpath )
autoload -U promptinit && promptinit
zstyle ':prompt:pure:prompt:success' color green
prompt pure
