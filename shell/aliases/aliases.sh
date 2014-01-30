# directory aliases
# use like: ls ~src OR ~src OR du -h ~src
c=~/Code

alias fu='fresh update'

# Edit dotfiles
alias d='(cd ~/.dotfiles && vim && gad && gcav && glr && gp) && fresh && . ~/.zshrc'
alias so='. ~/.zshrc'

# Edit brightbit/guides #TODO: Find a better place for this as the git aliases aren't available yet
function bg(){ (cd ~/Code/guides && vim && git checkout -b ${1:=$USER-$(date|md5)} && git add . && git commit -av && git pull --rebase origin && git push -u && git pull-request) }

# Use color in grep
alias grep='grep --color=auto'

# ls
alias l="ls -lahF"
alias ll="ls -l"
alias la='ls -A'

# PostgreSQL
alias pg_start="pg_ctl -D /usr/local/var/postgres -l /usr/local/var/postgres/server.log start"
alias pg_stop="pg_ctl -D /usr/local/var/postgres stop -s -m fast"

# Misc
alias v='vim'
alias x=exit
alias cl=clear
alias ee='eval $(cat .env)'
alias json="python -mjson.tool"
alias xml="xmllint --format -"
kp(){ sudo kill $(ps auxww | grep ssh | grep -e '^pair' | awk '{print $2}') }

## Used in a blue moon
# tmux ssh agent forwarding hack
alias safix='export SSH_AUTH_SOCK=$(find /tmp/ssh-* -user $(whoami) -name agent\* 2>/dev/null |tail -1)'
sasw()  { export SSH_AUTH_SOCK=/tmp/ssh-agent-$1-screen }
saswa() { ln -nfs /tmp/ssh-agent-$1-screen /tmp/ssh-agent-$USER-screen }

# Tmux
alias ks='tmux kill-session'
alias ksp='tmux -S /tmp/tmux-pair-session kill-session'
alias tnp='tmux -S /tmp/tmux-pair-session new'
alias tap='tmux -S /tmp/tmux-pair-session attach'

# OS X
# This only prompts for keychain access if you have an https credential configured in your .gitconfig as this is the only time I know of
# that one would need to use this command. See: https://help.github.com/articles/which-remote-url-should-i-use
ensure_keychain_unlocked_over_ssh() { [[ -n $SSH_CONNECTION ]] && [[ $OSTYPE == darwin* ]] && git config --get-regex 'credential.https*' 1&>- && (security unlock-keychain -u 1&>- || security unlock-keychain) || (exit 0) }
