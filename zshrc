[[ -f ~/.zsh/config.private ]] && . ~/.zsh/config.private
[[ -f ~/.zsh/config         ]] && . ~/.zsh/config
[[ -f ~/.zsh/completion     ]] && . ~/.zsh/completion
[[ -f ~/.zsh/aliases        ]] && . ~/.zsh/aliases
[[ -f ~/.zsh/theme          ]] && . ~/.zsh/theme

# use .localrc for settings specific to one system
[[ -f ~/.localrc ]] && . ~/.localrc

# load preexec to time commands
[[ -f ~/.preexec ]] && . ~/.preexec

