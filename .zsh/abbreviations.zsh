# Adopted from http://stackoverflow.com/questions/28573145/how-can-i-move-the-cursor-after-a-zsh-abbreviation

setopt extendedglob

typeset -A abbrevs

# General aliases
abbrevs=(
  "ll"   "ls -al"
  "killsshtty" 'kill $(ps auxww | grep ssh | grep tty| awk "{print \$2}")'
  "kp" 'sudo kill $(ps auxww | grep ssh | grep -e "^pair" | awk "{print \$2}") ; chmod 770 /tmp/tmux-pair'
  "jsun" "python -mjson.tool"
  "tl" 'vi /Users/ericboehs/Library/Mobile\ Documents/com~apple~CloudDocs/Documents/Time\ Logs.txt'
  "pag" 'ps auxww | grep'
  "fdg" "find . | grep"
  "rsss"  "rsync -azP ~/Code/17hats/suitesetup/ eric.dev.17hats.com:/mnt/suitesetup/"
  "pgr" "| grep"
  "awkp" "| awk '{print \$__CURSOR__}'"
  )

# Dotfiles
abbrevs+=(
  "cab" "cat ~/.zsh/abbreviations.zsh"
  "dof" "cd ~/.dotfiles; vim; . ~/.zshrc"
  "dz" '. ~/.zshrc'
)

# Tmux
abbrevs+=(
  "tan"  "tmux -S /tmp/tmux-pair attach -t pair || tmux -S /tmp/tmux-pair new -s pair -n editor"
  "tnwa"  "tnwsh; tnwsr; tnwb; tnwl; tnwp; tmux select-window -t 1"
  "tnwsh" "tmux new-window -t 2 -n shell"
  "tnwsr" "tmux new-window -t 3 -n server"
  "tnwb"  "tmux new-window -t 7 -n boards vim -p board-now.md board-later.md board-scratch-pad.md"
  "tnwl"  "tmux new-window -t 8 -n logs \"while ((1)) { heroku logs -t -r production }\""
  "tnwp"  "tmux new-window -t 9 -n ping ping 8.8.8.8"

  "tks"   "tmux kill-session"

  "c7tp"  "chmod 777 /tmp/tmux-pair"
)

# EC2 CLI
abbrevs+=(
  "exaws" 'export AWS_ACCESS_KEY="$(git config --get aws.access-key)"; export AWS_SECRET_KEY="$(git config --get aws.secret-key)"'
  "start_lmu_manager" 'aws ec2 start-instances --instance-ids $(git config --get aws.lmu-manager-instance-id)'
  "stop_lmu_manager" 'aws ec2 stop-instances --instance-ids $(git config --get aws.lmu-manager-instance-id)'
)

# Ruby
abbrevs+=(
  "rdm" "rake db:migrate"
  "rrun" "rails runner"
  "rap" 'rails runner "ap '
  "rit" "ruby -Itest"
)

# Heroku
abbrevs+=(
  "hk"   "heroku"
  "hkl"  "heroku logs -t"
  "hkc"  "heroku config"
  "hkcs" "heroku config:set"
  "hkps" "heroku ps"
  "hkr"  "heroku run"
  "hkrc" "heroku run console"
  "drp" "-r production"
  "hsp" "-a hats-staging-pr-"
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
  "dkbt"  "docker build -t __CURSOR__ ."
  "drid"  "docker rmi -f \$(docker images -q -f \"dangling=true\")"
)

# Vim
abbrevs+=(
  "vrcf" 'vim -c ":RuboCop $(git diff origin/master:./ --name-only | grep -E .rb$ | paste -sd\  -)"'
  "vbi"  'vim -c "BundleInstall" -c "q" -c "q"'
  "vbs"  'vim -p board-now.md board-later.md board-scratch-pad.md'
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

# Invoker
abbrevs+=(
  "ins"   "invoker start"
  "inp"   "invoker stop"
  "inr"   "invoker reload"
  "inrw"  "invoker reload web"
  "inrss" "invoker reload suitesetup"
  "int"   "invoker tail"
)

# Git aliases
abbrevs+=(
  "gs"    "git status"
  "gg"    "git lg"
  "ggm"   "git lg origin/master.."
  "ggh"   "git lg | head"
  "ggmh"  "git lg origin/master.. | head"
  "ggg"   "git ll"

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

  "gco"   "git checkout"
  "gcom"  "git checkout master"
  "gcopr" 'git checkout $(git pulls list | grep "^__CURSOR__" | sed -n "s/^\(.*\):\(.*\)$/\2/p")'
  "gcl"   "git clone"
  "gb"    "git branch"
  "gba"   "git branch -a"
  "gbmd"  'git branch --merged | grep  -v "\*\|master" | xargs -n1 git branch -d'
  "gbrmd" 'git branch -r --merged | grep origin | grep -v "\->\|master" | cut -d"/" -f2- | xargs git push origin --delete'

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

  "grb"   "git rebase"
  "grbi"  "git rebase -i"
  "grba"  "git rebase --abort"
  "grbc"  "git rebase --continue"
  "grbm"  "git rebase master"
  "grbom"  "git rebase origin/master"
  "grbim" "git rebase -i master"

  "grhu"  "git reset --hard @{u}"
  "grsm"  "git reset --soft master"

  "gchp"  "git cherry-pick"
  "gchpc" "git cherry-pick --continue"
  "gchpa" "git cherry-pick --abort"

  "gsh"  "git show"
  "gshh" "git show HEAD"

  "gsu" "git submodule update --init --recursive"

  "gst"  "git stash"
  "gstl" "git stash list"
  "gstp" "git stash pop"

  "br"   "git checkout -b"

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
