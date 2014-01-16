# Git
type compdef >/dev/null 2>&1 && compdef hub=git
type hub >/dev/null 2>&1 && alias git='hub'
alias ga='git add'
alias gaa='git add --all'
alias gad='git add .'
alias gadu='git add -u .'
alias gap='git add -p'
alias gapc='git add -p && git commit -v'
alias gapcp='git add -p && git commit -v && git push -u'

alias gl='git pull'
alias glr='git pull --rebase'

alias gp='git push'
alias gpu='git push -u'

alias grb='git rebase'
alias grbm='git rebase master'
alias grba='git rebase --abort'
alias grbc='git rebase --continue'

alias gpr='hub pull-request'

alias gd='git diff'
alias gdh='git diff HEAD'
alias gdc='git diff --cached'
alias gdt='git difftool'

alias gc='git commit'
alias gcv='git commit -v'
alias gca='git commit -a'
alias gcav='git commit -av'
alias gcaa='git commit --amend'
alias gcane='git commit --amend --no-edit'
alias gcaane='git commit -a --amend --no-edit'
alias gcap='git commit -av && git push -u'
alias gcapr='git commit -av && git push -u && hub pull-request'
alias gcp='git commit -v && git push -u'
alias gcpr='git commit -v && git push -u && hub pull-request'
alias gacpr='git add . && git commit -av && git push -u && hub pull-request'

alias gco='git checkout'
alias gcom='git checkout master'
alias gcl='git clone'
alias gb='git branch'
alias gba='git branch -a'
alias gbwho="git branch --remote | grep -v master | grep origin | xargs -n1 -J {} sh -c 'git log \$0 | head -2 | tail -1|cut -f2 -d\\  && echo  \$0'|paste -d\" \" - - | sort"
alias gbwhov="git for-each-ref --sort=-committerdate --format='%(committerdate) %(authorname) %(refname)' refs/remotes/origin/|grep -e \".\$@\"|head -n 10"
alias gbmd='git branch --merged | grep -v "\*" | xargs -n 1 git branch -d'
alias prune='git remote prune origin'

alias g='git status'
alias gg='git lg'
alias ggg='git ll'

gra() { git remote add ${2:-"origin"} $1 }
grah() { git remote add $2 git@heroku.com:$1.git }
alias grv='git remote -v'
alias grrm='git remote rm'
alias gru='git remote update'
alias gruo='git remote update origin'

alias gsu="git submodule update --init --recursive"

alias changelog='git log $(git log -1 --format=%H -- CHANGELOG*)..; cat CHANGELOG*'

alias yolo='git commit -a --amend --no-edit && git push -f'
function unyolo() { git checkout master && git branch -D $1 && git remote update origin && git checkout $1 }
