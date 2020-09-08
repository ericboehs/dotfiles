[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
export FZF_DEFAULT_COMMAND='rg --files --hidden'

_gen_fzf_default_opts() {
  local base03="0"
  local base02="8"
  local base01="10"
  local base00="11"
  local base0="12"
  local base1="14"
  local base2="7"
  local base3="15"
  local yellow="3"
  local orange="9"
  local red="1"
  local magenta="5"
  local violet="13"
  local blue="4"
  local cyan="6"
  local green="2"

  # Solarized Dark color scheme for fzf
  export FZF_DEFAULT_OPTS_DARK="
    --color fg:-1,bg:-1,hl:$blue,fg+:$base2,bg+:$base02,hl+:$blue
    --color info:$magenta,prompt:$magenta,pointer:$base3,marker:$base3,spinner:$magenta
  "

  ## Solarized Light color scheme for fzf
  export FZF_DEFAULT_OPTS_LIGHT="
    --color fg:-1,bg:-1,hl:$blue,fg+:$base02,bg+:$base2,hl+:$blue
    --color info:$yellow,prompt:$yellow,pointer:$base03,marker:$base03,spinner:$yellow
  "

  export FZF_DEFAULT_OPTS=$(defaults read -g AppleInterfaceStyle 2>&1 | grep -q Dark && echo $FZF_DEFAULT_OPTS_DARK || echo $FZF_DEFAULT_OPTS_LIGHT)
}

_gen_fzf_default_opts

preexec() {
  export FZF_DEFAULT_OPTS=$(defaults read -g AppleInterfaceStyle 2>&1 | grep -q Dark && echo $FZF_DEFAULT_OPTS_DARK || echo $FZF_DEFAULT_OPTS_LIGHT)
}
