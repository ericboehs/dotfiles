# Adopted from http://stackoverflow.com/questions/28573145/how-can-i-move-the-cursor-after-a-zsh-abbreviation

setopt extendedglob

typeset -A abbrevs

# General aliases
abbrevs=(
  "l" "ls -al"
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

  "gd"    "git diff"
  "gdm"   "git diff master.."
  "gdc"   "git diff --cached"
  "gdt"   "git difftool"
  "gdh"   "git diff HEAD~${1:=0}"

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
)

for abbr in ${(k)abbrevs}; do 
  alias -g $abbr="${abbrevs[$abbr]}"
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
