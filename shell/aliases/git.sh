# Git
type compdef >/dev/null 2>&1 && compdef hub=git
type hub >/dev/null 2>&1 && alias git='hub'
alias ga='git add'
alias gaa='git add --all'
alias gad='git add .'
alias gau='git add -u'
alias gap='git add -p'
alias gapc='git add -p && git commit -v'
alias gapcp='git add -p && git commit -v && git push -u'
alias gapcpr='git add -p && git commit -v && git push -u && hub pull-request && latestpr | rpbcopy'

alias gl='git pull --prune'
alias glr='git pull --rebase --prune'
alias glrd='git pull --rebase --prune && gbmd'
alias glrdb='git pull --rebase --prune && gbmd && gba'

alias gp='git push'
alias gpf='git push --force-with-lease'
alias gpu='git push -u'

alias gchp='git cherry-pick'
alias gchpc='git cherry-pick --continue'
alias gchpa='git cherry-pick --abort'

alias vgu='vim $(git ls-files --unmerged | cut -f2 | sort -u)'

gcopr() {
  [[ -e $GHI_NEXT_PR ]] || setnpr
  PR_ID=${1:=$GHI_NEXT_PR}
  [[ -z $PR_ID ]] && echo "You must specify a PR id" && kill -INT $$
  git branch -D pr-$PR_ID 2>&1 | grep -v 'not found.'
  git fetch origin || kill -INT $$
  git checkout master 2>&1 | grep -v "Already on 'master'" || kill -INT $$
  git fetch origin pull/$PR_ID/head:pr-$PR_ID || kill -INT $$
  BRANCH="$(git branch -a --contains pr-$PR_ID | grep -v pr-$PR_ID | tr -d '[:space:]' | cut -f3 -d/)"
  git branch -D $BRANCH 2>&1 | grep -v 'not found.'
  git branch -D pr-$PR_ID 1>/dev/null
  git checkout $BRANCH
}

alias gmnf='git merge --no-ff'
gmb() {
  git fetch origin && \
  git checkout $1 && \
  git checkout master && \
  git merge --no-ff $1 && \
  git push && \
  git branch -D $1 && \
  git push --delete origin $1 && \
  git remote prune origin
}

gmpr() {
  [[ -e $GHI_NEXT_PR ]] || setnpr
  PR_ID=${1:=$GHI_NEXT_PR}
  gcopr $PR_ID
  git checkout master
  git merge --no-ff -m "Merge pull request #$PR_ID from $BRANCH" $BRANCH && (
    git push
    git branch -D $BRANCH
    git push --delete origin $BRANCH
    git remote prune origin
  )
}

alias grb='git rebase'
alias grbm='git rebase master'
alias grba='git rebase --abort'
alias grbc='git rebase --continue'
alias grbs='git rebase --skip'
alias grbim='git rebase -i HEAD~$(git log --pretty=oneline master.. | wc -l | tr -d "[:space:]")'

alias gpr='hub pull-request && latestpr | rpbcopy'
alias gprm='git log master.. --format="%B" --reverse > .git/PULLREQ_EDITMSG && git push -u && hub pull-request && latestpr | rpbcopy'

alias gd='git diff'
alias gdm='git diff master..'
alias gdc='git diff --cached'
alias gdt='git difftool'
gdh() { git diff HEAD~${1:=0} }

alias gc='git commit -v'
alias gca='git commit --amend -v'
alias gcane='git commit --amend --no-edit'
alias gcp='git commit -v && git push -u'
alias gcpr='git commit -v && git push -u && hub pull-request && latestpr | rpbcopy'

alias gco='git checkout'
alias gcom='git checkout master'
alias gcl='git clone'
alias gb='git branch'
alias gba='git branch -a'
alias gbdl='git branch -D @{-1}'
alias gbwho="git branch --remote | grep -v master | grep origin | xargs -n1 -J {} sh -c 'git log \$0 | head -2 | tail -1|cut -f2 -d\\  && echo  \$0'|paste -d\" \" - - | sort"
alias gbwhov="git for-each-ref --sort=-committerdate --format='%(committerdate) %(authorname) %(refname)' refs/remotes/origin/|grep -e \".\$@\"|head -n 10"
alias gbmd='git branch --merged | grep -v "\*" | xargs -n 1 git branch -d'
alias prune='git remote prune origin'

alias g='git status'
alias gg='git lg'
alias ggg='git ll'
alias ggh='git lg | head'

gra() { git remote add ${2:-"origin"} $1 }
grah() { git remote add $2 git@heroku.com:$1.git }
alias grv='git remote -v'
alias grrm='git remote rm'
alias gru='git remote update'
alias gruo='git remote update origin'

alias gsu='git submodule update --init --recursive'

alias gf='git fetch'
alias gfo='git fetch origin'
alias gtfo='git fetch origin'

alias gs='git stash'
alias gsp='git stash pop'

alias changelog='git log $(git log -1 --format=%H -- CHANGELOG*)..; cat CHANGELOG*'
worklog() { git log --date=relative --reverse --since "${*:-"1 Saturday Ago"}" --author="$(git config --get user.name)" --format='"%cI","%B"' --no-merges }
# Assumes CSV from STDIN with first field as date and second field as an entry (pairs with worklog)
alias csv_by_date="ruby -rcsv -e 'e=CSV(\$stdin).reduce({}){|e,r|k=r[0][0..9];e[k]=(e[k]||[])+[r[1]];e}; e.each{|d,l| puts d; l.each{|l| puts l};puts}'"

alias yolo='git commit --amend --no-edit && git push --force-with-lease'
function unyolo() { git checkout master && git branch -D $1 && git remote update origin && git checkout $1 }
alias gapyolo='gap && yolo'

alias latestpr='curl -s "https://api.github.com/repos/$(git config --get remote.origin.url | cut -d "/" -f4-)/pulls?state=open&access_token=$(git config ghi.token)" | jq ".[0]._links.html.href" | tr -d \"\\n'

function br() { git checkout -b ${GIT_BRANCH_SUFFIX:-"eb"}-$1 2> /dev/null || git checkout ${GIT_BRANCH_SUFFIX:-"eb"}-$1 }
