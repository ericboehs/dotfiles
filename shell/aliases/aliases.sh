# directory aliases
# use like: ls ~src OR ~src OR du -h ~src
db=/Volumes/Dropbox/Dropbox

alias fu='fresh update'

# Edit dotfiles
alias d='(cd ~/.dotfiles && vim && gad && gc -a && glr && gp) && fresh && . ~/.zshrc'

# Use color in grep
alias grep='grep --color=auto'

# ls
c() { cd $@ && ls -lahF }
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
alias json="python -mjson.tool"
alias xml="xmllint --format -"
alias hn='noglob hcl note'
alias allowpair='chmod 777 /tmp/tmux-pair-session'
define(){ echo "DEFINE !wn $@" | nc dict.org 2628 }
y(){ echo \"$(history | tail -1 | cut -d ' ' -f3-)\" crits you for $RANDOM damage. }
n(){ echo \"$(history | tail -1 | cut -d ' ' -f3-)\" crits you for $RANDOM damage. }
kp(){ sudo kill $(ps auxww | grep ssh | grep -e '^pair' | awk '{print $2}') ; chmod 770 /tmp/tmux-pair-session }
killsshtty(){ kill $(ps auxww | grep ssh | grep tty| awk '{print $2}') }
noh(){ nohup $* >/dev/null 2>&1 & }

# Tmux
alias ks='tmux kill-server'
alias ksp='tmux -S /tmp/tmux-pair-session kill-session'
alias tp='tmux -S /tmp/tmux-pair-session new -s pair || tmux -S /tmp/tmux-pair-session attach -t pair'
alias tpr='tmux -S /tmp/tmux-pair-session new -t pair -s rogue || tmux -S /tmp/tmux-pair-session attach -t rogue'
alias tprk='tmux -S /tmp/tmux-pair-session kill-session -t rogue'

# Tmux + Vim
vo(){
  file="$@"
  TPANE=$(tmux list-panes -s -F '#{window_index}.#{pane_index} #{pane_current_command}' | grep Vim | head -1 | cut -f 1 -d ' ')
  tmux send-keys -t $TPANE ":o $file" "C-j"
}
vos(){ vo $@ && tmux select-window -t $(echo $TPANE|cut -f1 -d.) && tmux select-pane -t $TPANE }

# OS X
# This only prompts for keychain access if you have an https credential configured in your .gitconfig as this is the only time I know of
# that one would need to use this command. See: https://help.github.com/articles/which-remote-url-should-i-use
ensure_keychain_unlocked_over_ssh() { [[ -n $SSH_CONNECTION ]] && [[ $OSTYPE == darwin* ]] && git config --get-regex 'credential.https*' &> /dev/null && (security unlock-keychain -u &> /dev/null || security unlock-keychain) || (exit 0) }
