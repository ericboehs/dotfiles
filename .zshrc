# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

autoload -Uz compinit; compinit # Expand directory path shorthand (e.g. cd Co/eri/tm/cach/a<Tab>)
setopt interactivecomments      # Allow comments after commands
setopt autocd                   # cd to directories without typing cd
setopt extendedglob             # Expand file expression (e.g. **/file)
# setopt no_beep                  # No more bells!

export CLICOLOR=1 # Enable color in some commands (e.g. ls)
export EDITOR=nvim
export GIT_MASTER_BRANCH=master # Use env var to set default git branch name

source "$HOME/.zsh/history.zsh"
source ~/Code/powerlevel10k/powerlevel10k.zsh-theme
source "$HOME/.zsh/asdf.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
source "$HOME/.zsh/fzf.zsh"
source "$HOME/.zsh/auto-notify.plugin.zsh"
source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh

# Inlcude a private/local zshrc for ENV secrets and customizations
[[ -f "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"

# TODO: Move these; and make them work:
opsi() {
  eval $(op signin)
  sed -i '' '/export OP_SESSION_my/d' ~/.zshrc.local
  env | grep OP_SESSION_my | sed -e 's/^/export /' >> ~/.zshrc.local
}

mfa() {
  source ~/Code/department-of-veterans-affairs/devops/utilities/issue_mfa.sh Eric.Boehs $1
  sed -i '' '/export AWS_/d' ~/.zshrc.local
  env | grep AWS_ | sed -e 's/^/export /' >> ~/.zshrc.local
}

review_pr() {
  pr_id=$1
  gh pr view $pr_id --comments; git fetch -q; out_of_date=$(git rev-list --left-right --count origin/$GIT_MASTER_BRANCH...$(echo "origin/$(gh pr view $pr_id --json headRefName | jq .headRefName | tr -d '\"')") | awk '{print $1}'); [[ $out_of_date -gt 20 ]] && echo "‼️  Branch is $out_of_date commits out of date with $GIT_MASTER_BRANCH."; gh pr checks $pr_id; gh pr diff $pr_id; echo -n "[approve] or request-changes? "; read review; gh pr review $pr_id --${review:-approve}
}

review_prs() {
  pr_id=$(GH_FORCE_TTY=100 gh pr list --limit 200 --search "is:pr is:open draft:false NOT WIP in:title review-requested:@me review:required -label:Lighthouse label:console-services-review" | fzf --ansi --preview 'GH_FORCE_TTY=100 gh pr view {1}' --preview-window down --header-lines 3 | awk '{print $1}' | tr -d '#');
  review_pr $pr_id
}

copilot_shell_suggest() { gh copilot suggest -t shell "$@" }
alias '??'='copilot_shell_suggest';

alias ls=lsd

export PATH="/opt/homebrew/opt/libxml2/bin:$PATH"

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# Zoxide (cd replacement)
eval "$(zoxide init zsh)"
