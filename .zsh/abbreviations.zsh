# Adopted from http://stackoverflow.com/questions/28573145/how-can-i-move-the-cursor-after-a-zsh-abbreviation

typeset -A abbrevs

# General aliases
abbrevs=(
  "ll"   "lsd -al"
  "l1"   "lsd -1A"
  "mdc"  "mkdir -p __CURSOR__ && cd \$_"
  "killsshtty" 'kill $(ps auxww | grep ssh | grep tty| awk "{print \$2}")'
  "kp" 'sudo kill $(ps auxww | grep ssh | grep -e "^pair" | awk "{print \$2}") ; chmod 770 /tmp/tmux-501'
  "jsun" "python -mjson.tool"
  "pag" 'ps auxww | grep'
  "fdg" "find . | grep"
  "pgr" "| grep"
  "awkfp" "| awk -F'__CURSOR__' '{print \$1}'"
  "awkp" "| awk '{print \$__CURSOR__}'"
  "tstamp" "| while read line; do ; echo \$(date | cut -f4 -d ' ') \$line; done"
  "rlw"  'readlink $(which __CURSOR__)'
  "wtnoti" "while do; noti; sleep 120; done"
  "wt"     "while; do clear; __CURSOR__; sleep 5; done"
  "wtbb"   "while; do !!; clear; sleep 5; done"
  "ut"     "clear && until __CURSOR__; do sleep 5; done"
  "utbb"   "clear && until !!; do sleep 5; done"
  "epoch" "date +%s"
  "epochms" 'echo $(($(gdate +%s%N)/1000000))'
  "oedm" "osascript -e 'tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode'"
  "rfs" "refresh_safari"
  "trash" "mv __CURSOR__ ~/.Trash"
  "gcs" "gh copilot suggest -t shell \"__CURSOR__\""
  "rr" "cd \$(git rev-parse --show-toplevel)"
)

# Dotfiles
abbrevs+=(
  "cab" "cat ~/.zsh/abbreviations.zsh"
  "vab" "nvim ~/.zsh/abbreviations.zsh"
  "dof" "cd ~/Code/ericboehs/dotfiles; nvim; zsh; . ~/.zshrc; cd -"
  "dz" '. ~/.zshrc'
  "sase" "set -a; source .env; set +a"
)

# Homebrew
abbrevs+=(
  "ibr"   "arch -x86_64 /usr/local/bin/brew"
  "ibrew" "arch -x86_64 /usr/local/bin/brew"
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
  "ta"    "tmux -u attach"
  "tan"   "tmux -u attach || (tmux -u new -d -s 👨🏼‍💻 -n editor; tmux new -d -s 📝; tmux send-keys -t 📝:1.0 'nvim -c :VimwikiIndex' C-m; tmux new -d -s 📻; tmux send-keys -t 📻:1.0 'ncmpcpp' C-m; sleep 1; tmux -u attach -t 👨🏼‍💻)"
  "tda"   "tmux detach -a"
  "tsw"   "tmux split-window"
  "tswrc" "tmux split-window rails c"
  "tswrs" "tmux split-window rails s"
  "tswv"  "tmux split-window nvim"
  "tnw"   "tmux new-window"
  "tnwa"  "tnw; tnws; tnwj; tnwc; tnwm; tnwr; tmux select-window -t 1"
  "tnws"  "tmux new-window -n server rails s"
  "tnwws" "tmux new-window -n server bin/webpack-dev-server \; split-window -v rails s"
  "tnwj"  "tmux new-window -n journal nvim ~/Documents/Notes/\$(date +%Y-%m)-Journal.md \"+/^## \$(date +%d)...\" -c noh"
  "tnwc"  "tmux new-window -n chat weechat"
  "tnwm"  "tmux new-window -n mail mutt"
  "tnwr"  "tmux new-window -n rss newsboat"
  "tnwl"  "tmux new-window -n logs \"while ((1)) { heroku logs -t -r production }\""
  "tnwp"  "tmux new-window -n ping ping 8.8.8.8"

  "tks"   "tmux kill-session"

  "screst"  "sudo chown -R ericboehs:staff /tmp/tmux-501"
  "cr7t"  "chmod -R 777 /tmp/tmux-501"
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
  "vdm"  'nvim db/migrate/$(ls db/migrate | tail -1)'
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

# Kube
abbrevs+=(
  "kc"    "kubectl"
  "kgn"   "kubectl get nodes"
  "kgp"   "kubectl get pods"
  "kgs"   "kubectl get services"
  "klf"   "kubectl logs -f"
  "kaf"   "kubectl apply -f"
)

# Vim
abbrevs+=(
  "vrcf" 'nvim -c ":RuboCop $(git diff origin/\$GIT_MASTER_BRANCH:./ --name-only | grep -E .rb$ | paste -sd\  -)"'
  "vi"   'nvim'
  "wix"   'nvim -c "VimwikiIndex"'
  "wid"  'nvim -c "VimwikiDiaryIndex"'
  "wi"   'nvim -c "VimwikiMakeDiaryNote"'
  "wim"   'nvim -c "VimwikiMakeTomorrowDiaryNote"'
  "wiy"   'nvim -c "VimwikiMakeYesterdayDiaryNote"'
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
  "gs"    "git status -s"
  "gsl"   "git status"
  "gg"    "git lg"
  "ggm"   "git lg origin/\$GIT_MASTER_BRANCH.."
  "ggh"   "git lg --color | head"
  "ggmh"  "git lg origin/\$GIT_MASTER_BRANCH.. --color | head"
  "ggg"   "git ll"
  "glogmh" "git log --oneline --graph \$GIT_MASTER_BRANCH HEAD"

  "ga"   "git add"
  "gad"  "git add ."
  "gadcp" "git add . && git commit -m 'Auto-commit' && git push"
  "gaud"  "git add -u ."
  "gap"  "git add -p"

  "gapc"  "git add -p && git commit"
  "gapcp" "git add -p && git commit && git push -u"

  "gc"    "git commit"
  "gcp"   "git commit && git push -u"
  "gca"   "git commit --amend"
  "gcane" "git commit --amend --no-edit"
  "gcm"   "git commit -m"
  "gcmw"   "git commit -m wip"

  "gcb"     "git checkout -b"
  "gco"     "git checkout"
  "gcom"    "git checkout \$GIT_MASTER_BRANCH"
  "gcoh"    "git checkout HEAD"
  "gcohd"   "git checkout HEAD --"
  "gcohgl"  "git checkout HEAD -- Gemfile.lock"
  "gcohglb" "git checkout HEAD -- Gemfile.lock; bundle"
  "gcohyly" "git checkout HEAD -- yarn.lock; yarn"

  "gcl"     "git clone"
  "gclc"    "git clone __CURSOR__ && cd \$(basename \$_)"
  "gb"      "git branch"
  "gbz"     "git branch | fzf | xargs git checkout"
  "gbm"     "git branch -M"
  "gbv"     "git branch -vv"
  "gba"     "git branch -a"
  "gbav"    "git branch -a -vv"
  "gbsc"    "git branch --show-current"
  "gbsmd"   "git fetch -p && for branch in \$(git branch -vv | grep ': gone]' | awk '{print \$1}'); do git branch -D \$branch; done"

  "gbmd"   'git branch --merged | grep  -v "\*\|master" | xargs -n1 git branch -d'
  "gbrmd"  'git branch -r --merged | grep origin | grep -v "\->\|master" | cut -d"/" -f2- | xargs git push origin --delete'

  "gd"    "git diff"
  "gdm"   "git diff origin/\$GIT_MASTER_BRANCH.."
  "gdms"  "git diff origin/\$GIT_MASTER_BRANCH:./"
  "gdc"   "git diff --cached"
  "gdt"   "git difftool"
  "gdh"   "git diff HEAD~1"
  "gdsh"  "git diff --stat __CURSOR__ HEAD~1"

  "gfo"   "git fetch origin"
  
  "gmnf"  "git merge --no-ff"

  "gp"    "git push"
  "gpu"   "git push -u"
  "gpf"   "git push --force-with-lease"
  "gpo"   "git push origin"
  "gpod"  "git push origin --delete"

  "gl"    "git pull"
  "glr"   "git pull --rebase"
  "glor"  "git pull origin --rebase"
  "glomr" "git pull origin \$GIT_MASTER_BRANCH --rebase"

  "ghrv"  "GHWR_URL=__CURSOR__;
GHWR_ID=\$(echo \$GHWR_URL | ggrep -oP 'runs/\K\d+')
gh run view --log-failed \$GHWR_ID"
  "ghrvr" "GHWR_URL=__CURSOR__;
GHWR_ID=\$(echo \$GHWR_URL | ggrep -oP 'runs/\K\d+')
gh run view --log-failed \$GHWR_ID | grep -A2 -E \"rspec [']?\./\""

  "gpr"    "gh pr create"
  "gprl"   "gh pr list"
  "gprlr"  "gh pr list --search \"is:pr is:open draft:false review-requested:@me review:required NOT WIP in:title -label:Lighthouse -label:mobile\""
  "gpco"   "gh pr checkout"
  "gpcor"  "GHPR_ID=\$(gh pr list --search \"is:pr is:open draft:false review-requested:@me review:required NOT WIP in:title -label:Lighthouse -label:mobile\" | fzf | awk '{print \$1}'); gh pr checkout \$GHPR_ID"
  "gprf"   "gh pr create --fill"
  "gprd"   "gh pr create --draft"
  "gprdf"  "gh pr create --draft --fill"
  "gprr"   "pr_id=__CURSOR__; gh pr view \$pr_id --comments; gh pr diff \$pr_id; echo -n \"[approve] or request-changes? \"; read review; gh pr review \$pr_id --\${review:-approve}"
  "gpvw"   "gh pr view --web"

  "gbr"    "gh browse"

  "grb"   "git rebase"
  "grbi"  "git rebase -i"
  "grba"  "git rebase --abort"
  "grbc"  "git rebase --continue"
  "grbm"  "git rebase \$GIT_MASTER_BRANCH"
  "grbom"  "git rebase origin/\$GIT_MASTER_BRANCH"
  "grbim" "git rebase -i \$GIT_MASTER_BRANCH"

  "grh"   "git reset --hard"
  "grhu"  "git reset --hard @{u}"
  "grsm"  "git reset --soft \$GIT_MASTER_BRANCH"

  "grlm"  "echo \"behind\\tahead\"; git rev-list --left-right --count \$GIT_MASTER_BRANCH..."

  "gchp"  "git cherry-pick"
  "gchpc" "git cherry-pick --continue"
  "gchpa" "git cherry-pick --abort"

  "gsh"  "git show"
  "gshh" "git show HEAD"

  "gsu"  "git submodule update --init --recursive"
  "gsgl" "git submodule -q foreach git pull -q origin \$GIT_MASTER_BRANCH"

  "gst"  "git stash"
  "gstl" "git stash list"
  "gstp" "git stash pop"

  "vgu"  'nvim $(git ls-files --unmerged | cut -f2 | sort -u)'
  "gcdi" "git clean -di"
)

# GitHub aliases
abbrevs+=(
  "ghs"    "gh pr checkout \$(unbuffer gh pr status | tail +4 | fzf --ansi --tac | awk '{print \$1}' | tr -d '#')"
  "ghco"   "gh pr checkout \$(unbuffer gh pr list | tail +4 | fzf --ansi | awk '{print \$1}' | tr -d '#')"
  "ghv"    "gh pr view"
  "ghm"    "gh pr merge"
  "ghd"    "gh pr diff"
  "ghr"    "gh pr review"
  "ghadmins" "REPO_PATH=\$(git remote get-url origin | sed 's|https://github.com/||'); __CURSOR__gh api /repos/\$REPO_PATH/collaborators --jq '.[] | select(.permissions.admin == true) | .html_url'; gh api /repos/\$REPO_PATH/teams --jq '.[] | select(.permissions.admin == true) | .html_url' "
)

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

# Fixes autosuggest not clearing when ENTER (^M) is pressed
export ZSH_AUTOSUGGEST_CLEAR_WIDGETS=(magic-abbrev-expand-and-execute)
