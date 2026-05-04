# compinit: skip insecure-dir audit + only rebuild .zcompdump once per day.
# Saves ~75ms on shell startup. -C skips compaudit; the mtime check rebuilds
# .zcompdump if it's older than 24h so new completions still get picked up.
autoload -Uz compinit
if [[ -n ~/.zcompdump(#qNmh-24) ]]; then
  compinit -C
else
  compinit
fi
setopt interactivecomments      # Allow comments after commands
setopt autocd                   # cd to directories without typing cd
setopt extendedglob             # Expand file expression (e.g. **/file)
# setopt no_beep                  # No more bells!

export CLICOLOR=1 # Enable color in some commands (e.g. ls)
export EDITOR=nvim
export GIT_MASTER_BRANCH=master # Use env var to set default git branch name

source "$HOME/.zsh/history.zsh"
source "$HOME/.zsh/path.zsh"
source "$HOME/.zsh/keybindings.zsh"
source "$HOME/.zsh/abbreviations.zsh"
source "$HOME/.zsh/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
source "$HOME/.zsh/fzf.zsh"
source "$HOME/.zsh/lsd.zsh"
source "$HOME/.zsh/auto-notify.plugin.zsh"
[[ -f /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]] && source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
[[ -f /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]] && source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh

# Inlcude a private/local zshrc for ENV secrets and customizations
[[ -f "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"

# TODO: Move these; and make them work:
opsi() {
  eval $(op signin)
  sed -i '' '/export OP_SESSION_my/d' ~/.zshrc.local
  env | grep OP_SESSION_my | sed -e 's/^/export /' >> ~/.zshrc.local
}

mfa() {
  source ~/Code/github.com/department-of-veterans-affairs/devops/utilities/issue_mfa.sh Eric.Boehs $1
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

llm_shell_suggest() {
  local template=${1:-cmd}
  shift
  llm -t $template "$*" | tee >(pbcopy)
}
alias '??'='llm_shell_suggest cmd-gem-flash'
alias '???'='llm_shell_suggest cmd-llama-70b'
alias '??o'='llm_shell_suggest cmd-4o'
alias '??r'='llm_shell_suggest cmd-history'

alias ls=lsd
#alias cd=z

# Search weechat logs (e.g. weelog foo)
alias weelog='cd /Users/ericboehs/.local/share/weechat/logs && rg'

# Search oddball slack emojis
alias ose='ranger ~/Code/oddballteam/slack-emojis/'

if [[ "$OSTYPE" == "darwin"* ]]; then
  export PATH="/opt/homebrew/opt/libxml2/bin:$PATH"
  export PATH="/Users/ericboehs/Code/ggerganov/whisper.cpp:$PATH"
  export OPENSSL_DIR="$(brew --prefix openssl)"
fi

# Zoxide (cd replacement)
# Only initialize in interactive shells to avoid issues with Claude Code
[[ $- == *i* ]] && [ -z "$DISABLE_ZOXIDE" ] && eval "$(zoxide init --cmd cd zsh)"

eval "$(starship init zsh)"
alias fsh='fnox exec -- zsh'

# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/ericboehs/.cache/lm-studio/bin"

# pnpm
export PNPM_HOME="/Users/ericboehs/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# bun completions
[ -s "/Users/ericboehs/.bun/_bun" ] && source "/Users/ericboehs/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
eval "$(mise activate zsh)"

# fnox: load AFTER mise (fnox is mise-installed). Drop the precmd hook so
# secrets only refresh on `cd`, not on every prompt — keeps op:// reads from
# pile-up when 1Password session is stale. --if-missing ignore so a single
# missing secret doesn't error the whole shell.
export FNOX_SHELL_OUTPUT=none
eval "$(fnox activate zsh --if-missing ignore)"
precmd_functions=( ${precmd_functions[@]:#_fnox_hook} )
_fnox_hook  # initial load (chpwd-only hook won't fire on shell start)

export ENABLE_LSP_TOOL=1
