## Pipe Aliases (Global)
alias -g L='|less'
alias -g G='|grep'
alias -g T='|tail'
alias -g H='|head'
alias -g W='|wc -l'
alias -g S='|sort'
alias -g K='|ruby -e "require %Q(open-uri); puts URI::encode STDIN.read" | while read i; do kiku $i; done'
