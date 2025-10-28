# Check out https://minsw.github.io/fzf-color-picker/
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Allow regex search like ^git to find history starting with git
export FZF_CTRL_R_OPTS="--no-sort --exact --preview 'echo {}' --preview-window down:3:wrap"

# Catpuccin Mocha
export FZF_DEFAULT_OPTS="$FZF_DEFAULT_OPS \
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8"
