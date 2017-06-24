# Add pure prompt. https://github.com/sindresorhus/pure
fpath=( "$HOME/.zsh/functions" $fpath )
autoload -U promptinit; promptinit
prompt pure
