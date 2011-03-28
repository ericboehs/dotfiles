. ~/.zsh/config
. ~/.zsh/aliases
. ~/.zsh/completion
. ~/.zsh/theme

# use .localrc for settings specific to one system
[[ -f ~/.localrc ]] && . ~/.localrc

# load preexec to time commands
[[ -f ~/.preexec ]] && . ~/.preexec

