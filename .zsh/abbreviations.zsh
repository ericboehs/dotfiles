# Adopted from http://stackoverflow.com/questions/28573145/how-can-i-move-the-cursor-after-a-zsh-abbreviation

setopt extendedglob

typeset -A abbrevs

# General aliases
abbrevs=(
  "l"   "ls -al"
  "dof" "(cd ~/.dotfiles && vim && git add . && git commit -av && git pull --rebase && git push && ./bootstrap.sh) && . ~/.zshrc"
  "killsshtty" 'kill $(ps auxww | grep ssh | grep tty| awk "{print \$2}")'
  "kp" 'sudo kill $(ps auxww | grep ssh | grep -e "^pair" | awk "{print \$2}") ; chmod 770 /tmp/tmux-pair'
  "json" "python -mjson.tool"
)

# EC2 CLI
abbrevs+=(
  "exaws" 'export AWS_ACCESS_KEY="$(git config --get aws.access-key)"; export AWS_SECRET_KEY="$(git config --get aws.secret-key)"'
  "start_lmu_manager" 'aws ec2 start-instances --instance-ids $(git config --get aws.lmu-manager-instance-id)'
  "stop_lmu_manager" 'aws ec2 stop-instances --instance-ids $(git config --get aws.lmu-manager-instance-id)'
)

# Ruby
abbrevs+=(
  "bi"  'bundle install -j8 --path vendor/bundle --binstubs vendor/bundle/bin'
  "bib" 'bundle install -j8 --path .bundle/bundle --binstubs .bundle/bundle/bin'
  "rdm" "rake db:migrate"
  "rap" 'rails runner "ap '
)

# Git aliases
abbrevs+=(
  "g"     "git status"
  "gg"    "git lg"
  "ggh"   "git lg | head"
  "ggg"   "git ll"

  "ga"   "git add"
  "gad"  "git add ."
  "gap"  "git add -p"

  "gapc"  "git add -p && git commit -v"
  "gapcp" "git add -p && git commit -v && git push"

  "gc"    "git commit -v"
  "gcp"   "git commit -v && git push"
  "gca"   "git commit --amend -v"
  "gcane" "git commit --amend -v --no-edit"

  "gco"   "git checkout"
  "gcom"  "git checkout master"
  "gcl"   "git clone"
  "gb"    "git branch"
  "gba"   "git branch -a"
  "gbmd"  'git branch --merged | grep  -v "\*\|master\|develop" | xargs -n1 git branch -d'

  "gd"    "git diff"
  "gdm"   "git diff master.."
  "gdc"   "git diff --cached"
  "gdt"   "git difftool"
  "gdh"   "git diff HEAD~1"

  "gp"    "git push"
  "gpf"   "git push --force-with-lease"
  "gpu"   "git push -u"

  "glr"   "git pull --rebase --prune"

  "gpr"  "hub pull-request"
  "gprm" 'git log master.. --format="%B" --reverse > .git/PULLREQ_EDITMSG && git push && hub pull-request'

  "grb"   "git rebase"
  "grbi"  "git rebase -i"
  "grba"  "git rebase --abort"
  "grbc"  "git rebase --continue"
  "grbim" 'git rebase -i HEAD~$(git log --pretty=oneline master.. | wc -l | tr -d "[:space:]")'

  "gchp"  "git cherry-pick"
  "gchpc" "git cherry-pick --continue"
  "gchpa" "git cherry-pick --abort"

  "gsu" "git submodule update --init --recursive"

  "gst"  "git stash"
  "gstl" "git stash list"
  "gstp" "git stash pop"

  "br"   "git checkout -b"
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
  LBUFFER+=${abbrevs[$MATCH]:-$MATCH}
  zle self-insert
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
