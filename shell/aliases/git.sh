# Git
which -s hub >/dev/null 2>&1 && alias git='hub'
alias ga='git add'

alias gl='git pull'
alias glr='git pull --rebase'

alias gp='git push'
alias gpu='git push -u'

alias gpr='hub pull-request'

alias gd='git diff'
alias gdh='git diff HEAD'

alias gc='git commit'
alias gcv='git commit -v'
alias gca='git commit -a'
alias gcav='git commit -av'
alias gcane='git commit --amend --no-edit'
alias gcaane='git commit -a --amend --no-edit'
alias gcp='git commit -av && git push -u'
alias gcpr='git commit -av && git push -u && hub pull-request'
alias gacpr='git add . && git commit -av && git push -u && hub pull-request'

alias gco='git checkout'
alias gcl='git clone'
alias gb='git branch'
alias gba='git branch -a'
alias gbmd='git branch --merged | grep -v "\*" | xargs -n 1 git branch -d'
alias prune='git remote prune origin'

alias gs='git status'

gra() { git remote add ${2:-"origin"} $1 }
grah() { git remote add $2 git@heroku.com:$1.git }
alias grv='git remote -v'
alias grrm='git remote rm'

alias gsu="git submodule update --init --recursive"

alias changelog='git log $(git log -1 --format=%H -- CHANGELOG*)..; cat CHANGELOG*'

alias yolo='git commit -a --amend --no-edit && git push -f'
