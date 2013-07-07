# directory aliases
# use like: ls ~src OR ~src OR du -h ~src
c=~/Code

alias fu='fresh update'

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
alias x=exit
alias cl=clear
alias ee='eval $(cat .env)'
alias json="python -mjson.tool"
alias xml="xmllint --format -"

## Used in a blue moon
# tmux ssh agent forwarding hack
alias safix='export SSH_AUTH_SOCK=$(find /tmp/ssh-* -user $(whoami) -name agent\* 2>/dev/null |tail -1)'
sasw()  { export SSH_AUTH_SOCK=/tmp/ssh-agent-$1-screen }
saswa() { ln -nfs /tmp/ssh-agent-$1-screen /tmp/ssh-agent-$USER-screen }

# Tmux pairing
alias tpnew='tmux -S /tmp/tmux-pair-session new -s pair -d && chmod 777 /tmp/tmux-pair-session && tmux -S /tmp/tmux-pair-session attach -t pair'
alias tpattach='tmux -S /tmp/tmux-pair-session attach -t pair'
