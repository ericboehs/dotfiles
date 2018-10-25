# Adopted from http://stackoverflow.com/questions/28573145/how-can-i-move-the-cursor-after-a-zsh-abbreviation

setopt extendedglob

typeset -A abbrevs

# General aliases
abbrevs=(
  "ll"   "ls -al"
  "l1"   "ls -1A"
  "mdc"  "mkdir -p __CURSOR__ && cd \$_"
  "killsshtty" 'kill $(ps auxww | grep ssh | grep tty| awk "{print \$2}")'
  "kp" 'sudo kill $(ps auxww | grep ssh | grep -e "^pair" | awk "{print \$2}") ; chmod 770 /tmp/tmux-501'
  "jsun" "python -mjson.tool"
  "pag" 'ps auxww | grep'
  "fdg" "find . | grep"
  "pgr" "| grep"
  "awkp" "| awk '{print \$__CURSOR__}'"
  "tstamp" "| while read line; do ; echo \$(date | cut -f4 -d ' ') \$line; done"
  "rlw"  'readlink $(which __CURSOR__)'
  "wtnoti" "while do; noti; sleep 120; done"
  "wt"     "while; do __CURSOR__; clear; sleep 5; done"
  "wtbb"   "while; do !!; clear; sleep 5; done"
  "ut"     "clear && until __CURSOR__; do sleep 5; done"
  "utbb"   "clear && until !!; do sleep 5; done"
  "epoch" "date +%s"
  "epochms" 'echo $(($(gdate +%s%N)/1000000))'
  )

# Dotfiles
abbrevs+=(
  "cab" "cat ~/.zsh/abbreviations.zsh"
  "vab" "vim ~/.zsh/abbreviations.zsh"
  "dof" "cd ~/.dotfiles; vim; . ~/.zshrc"
  "dz" '. ~/.zshrc'
  "sase" "set -a; source .env; set +a"
)

# Homebrew
abbrevs+=(
  "br"    "brew"
  "bri"   "brew install"
  "brui"  "brew uninstall"
  "brl"   "brew list"
  "brs"   "brew search"
  "bro"   "brew options"
  "brud"  "brew update"
  "brug"  "brew upgrade"
  "brod"  "brew outdated"
  "brdoc" "brew doctor"

  "brc"   "brew cask"
  "brci"  "brew cask install"
  "brcz"  "brew cask zap"
  "brcl"  "brew cask list"
  "brcs"  "brew cask search"
)

# Tmux
abbrevs+=(
  "ta"    "tmux attach"
  "tan"   "tmux attach || tmux new -n editor"
  "tsw"   "tmux split-window"
  "tswrc" "tmux split-window rails c"
  "tswrs" "tmux split-window rails s"
  "tswv"  "tmux split-window vim"
  "tnw"   "tmux new-window"
  "tnwa"  "tnw; tnws; tnwb; tmux select-window -t 1"
  "tnws"  "tmux new-window -n server bin/webpack-dev-server \; split-window -v rails s"
  "tnwb"  "tmux new-window -n boards vim -p board-now.md board-later.md board-scratch-pad.md"
  "tnwl"  "tmux new-window -n logs \"while ((1)) { heroku logs -t -r production }\""
  "tnwp"  "tmux new-window -n ping ping 8.8.8.8"

  "tks"   "tmux kill-session"

  "cr7t"  "chmod -R 777 /tmp/tmux-501"
)

# EC2 CLI
abbrevs+=(
  "exaws" 'export AWS_ACCESS_KEY="$(git config --get aws.access-key)"; export AWS_SECRET_KEY="$(git config --get aws.secret-key)"'
)

# Ruby
abbrevs+=(
  "rdm"  "rails db:migrate"
  "rds"  "rails db:seed"
  "rrun" "rails runner"
  "rit"  "ruby -Itest"
  "tf"   "tail -f"
  "tfl"  "tail -f log/__CURSOR__"
  "tfld" "tail -f log/development.log"
  "ttr"  "touch tmp/restart.txt"
  "vdm"  'vim db/migrate/$(ls db/migrate | tail -1)'
)

# Heroku
abbrevs+=(
  "hk"   "heroku"
  "hkgpr" "heroku git:remote -r pr -a"
  "hkb"  "heroku builds"
  "hkbo" "heroku builds:output"
  "hkbop" "REMOTE='__CURSOR__'; heroku builds:output \$(heroku builds -r \$REMOTE | grep pending | head -1 | awk '{print \$3}') -r \$REMOTE"
  "hkbopr" "heroku builds:output \$(heroku builds -r pr | grep pending | head -1 | awk '{print \$3}') -r pr"
  "hkbp" "heroku builds __CURSOR__ | grep pending | head -1 | awk '{print \$3}'"
  "hkl"  "heroku logs -t"
  "hkc"  "heroku config"
  "hkcs" "heroku config:set"
  "hkps" "heroku ps"
  "hkr"  "heroku run"
  "hkrc" "heroku run console"
  "rprod" "-r production"
  "rpr"  "-r pr"
)

# Docker
abbrevs+=(
  "dk"    "docker"
  "dkrit" "docker run -it"
  "dki"   "docker images"
  "dkig"  "docker images | grep __CURSOR__ | awk '{print \$3}'"
  "dm"    "docker-machine"
  "dmssh" "docker-machine ssh"
  "dc"    "docker-compose"
  "dkbd"  "docker build ."
  "dkbt"  "docker build -t __CURSOR__ ."
  "drid"  "docker rmi -f \$(docker images -q -f \"dangling=true\")"
)

# AWS
abbrevs+=(
  "depstaging" "aws opsworks update-app --app-id \$SPREEMO_STAGING_CHEWY_APP_ID --app-source Revision=__CURSOR__ ; aws opsworks create-deployment --stack-id \$SPREEMO_STAGING_STACK_ID --app-id \$SPREEMO_STAGING_CHEWY_APP_ID --command='{ \"Name\": \"deploy\", \"Args\": { \"migrate\": [\"true\"] } }'"
  "depdemo2" "aws opsworks update-app --app-id \$SPREEMO_DEMO2_CHEWY_APP_ID --app-source Revision=__CURSOR__ ; aws opsworks create-deployment --stack-id \$SPREEMO_DEMO2_STACK_ID --app-id \$SPREEMO_DEMO2_CHEWY_APP_ID --command='{ \"Name\": \"deploy\", \"Args\": { \"migrate\": [\"true\"] } }'"
)

# Vim
abbrevs+=(
  "vrcf" 'vim -c ":RuboCop $(git diff origin/master:./ --name-only | grep -E .rb$ | paste -sd\  -)"'
  "vbs"  'vim -p board-now.md board-later.md board-scratch-pad.md'
  "vi"   'vim'
)

# Bundler
abbrevs+=(
  "bi"   "bundle install"
  "be"   "bundle exec"
  "bod"  "bundle outdated"
  "bup"  "bundle update"
  "bop"  "bundle open"
  "begp" "bundle exec gem pristine"
)

# Git aliases
abbrevs+=(
  "gs"    "git status -sb"
  "gsl"   "git status"
  "gg"    "git lg"
  "ggm"   "git lg origin/master.."
  "ggh"   "git lg --color | head"
  "ggmh"  "git lg origin/master.. --color | head"
  "ggg"   "git ll"
  "glogmh" "git log --oneline --graph master HEAD"

  "ga"   "git add"
  "gad"  "git add ."
  "gaud"  "git add -u ."
  "gap"  "git add -p"

  "gapc"  "git add -p && git commit -v"
  "gapcp" "git add -p && git commit -v && git push -u"

  "gc"    "git commit -v"
  "gcp"   "git commit -v && git push -u"
  "gca"   "git commit --amend -v"
  "gcane" "git commit --amend --no-edit"
  "gcm"   "git commit -m"
  "gcmw"   "git commit -m wip"

  "gco"    "git checkout"
  "gcom"   "git checkout master"
  "gcopr"  'git checkout $(git pulls list | grep "^__CURSOR__" | sed -n "s/^\(.*\):\(.*\)$/\2/p")'
  "gcoh"   "git checkout HEAD"
  "gcohd"  "git checkout HEAD --"
  "gcohgl" "git checkout HEAD -- Gemfile.lock"
  "gcl"    "git clone"
  "gclc"   "git clone __CURSOR__ && cd \$(basename \$_)"
  "gb"     "git branch"
  "gbm"    "git branch -M"
  "gbv"    "git branch -vv"
  "gba"    "git branch -a"
  "gbav"   "git branch -a -vv"
  "gbsmd"  "git fetch -p && for branch in \$(git branch -vv | grep ': gone]' | awk '{print \$1}'); do git branch -D \$branch; done"

  "gbmd"   'git branch --merged | grep  -v "\*\|master" | xargs -n1 git branch -d'
  "gbrmd"  'git branch -r --merged | grep origin | grep -v "\->\|master" | cut -d"/" -f2- | xargs git push origin --delete'

  "gd"    "git diff"
  "gdm"   "git diff origin/master.."
  "gdms"  "git diff origin/master:./"
  "gdc"   "git diff --cached"
  "gdt"   "git difftool"
  "gdh"   "git diff HEAD~1"

  "gfo"   "git fetch origin"

  "gp"    "git push"
  "gpu"   "git push -u"
  "gpf"   "git push --force-with-lease"
  "gpo"   "git push origin"
  "gpod"  "git push origin --delete"

  "gl"    "git pull"
  "glr"   "git pull --rebase"
  "glor"  "git pull origin --rebase"
  "glomr" "git pull origin master --rebase"

  "glu"   "git pulls update"
  "gll"   "git pulls list"
  "gls"   "git pulls show"
  "glsf"  "git pulls show __CURSOR__ --full"
  "glb"   "git pulls browse"
  "glm"   "git pulls merge"

  "gpr"   "hub pull-request"
  "gprne" "EDITOR='vim -c \":wq\"' hub pull-request"
  "gprm"  'git log master.. --format="%B" --reverse > .git/PULLREQ_EDITMSG && git push -u && hub pull-request'
  "blb"   '-b $(git rev-parse --abbrev-ref @{-1})'

  "grb"   "git rebase"
  "grbi"  "git rebase -i"
  "grba"  "git rebase --abort"
  "grbc"  "git rebase --continue"
  "grbm"  "git rebase master"
  "grbom"  "git rebase origin/master"
  "grbim" "git rebase -i master"

  "grh"   "git reset --hard"
  "grhu"  "git reset --hard @{u}"
  "grsm"  "git reset --soft master"

  "gchp"  "git cherry-pick"
  "gchpc" "git cherry-pick --continue"
  "gchpa" "git cherry-pick --abort"

  "gsh"  "git show"
  "gshh" "git show HEAD"

  "gsu"  "git submodule update --init --recursive"
  "gsgl" "git submodule -q foreach git pull -q origin master"

  "gst"  "git stash"
  "gstl" "git stash list"
  "gstp" "git stash pop"

  "gcb"   "git checkout -b"

  "vgu"  'vim $(git ls-files --unmerged | cut -f2 | sort -u)'
  "gcdi" "git clean -di"
)

# Add alias and autocompleteion for hub
type compdef >/dev/null 2>&1 && compdef hub=git
type hub >/dev/null 2>&1 && alias git='hub'

for abbr in ${(k)abbrevs}; do
  alias $abbr="${abbrevs[$abbr]}"
done

magic-abbrev-expand() {
  local MATCH
  LBUFFER=${LBUFFER%%(#m)[_a-zA-Z0-9]#}
  command=${abbrevs[$MATCH]}
  LBUFFER+=${command:-$MATCH}

  if [[ "${command}" =~ "__CURSOR__" ]]; then
    RBUFFER=${LBUFFER[(ws:__CURSOR__:)2]}
    LBUFFER=${LBUFFER[(ws:__CURSOR__:)1]}
  else
    zle self-insert
  fi
}

magic-abbrev-expand-and-execute() {
  magic-abbrev-expand
  zle backward-delete-char
  zle accept-line
}

no-magic-abbrev-expand() {
  LBUFFER+=' '
}

zle -N magic-abbrev-expand
zle -N magic-abbrev-expand-and-execute
zle -N no-magic-abbrev-expand

bindkey " " magic-abbrev-expand
bindkey "^M" magic-abbrev-expand-and-execute
bindkey "^x " no-magic-abbrev-expand
bindkey -M isearch " " self-insert
