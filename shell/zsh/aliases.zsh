## Pipe Aliases (Global)
alias -g RCL=" > .git/last_pr_output | tail -1 | tr -d '\\n' | rpbcopy && cat .git/last_pr_output && rm .git/last_pr_output"
alias -g L='|less'
alias -g G='|grep'
alias -g T='|tail'
alias -g H='|head'
alias -g W='|wc -l'
alias -g S='|sort'
alias -g V='|view -'
alias -g Y='[[ $? -eq 0 ]] &&'

# Looks for "Points: 2" from STDIN then sums capture from match
alias -g POINTS="|ruby -e 'p STDIN.reduce(0){|sum, l| m = l.match /Points: ([0-9])+/; (m ? m.captures[0].to_i : 0) + sum}'"
alias -g P=POINTS

# Columnize ghi list output
alias -g COL='| tail +2 | sed "s/@$//" | sed "s/[0-9]\ $//" | sed "s/[0-9]$//" | column -s "[]" -t'

# While true do command, clear, sleep
function wt() { while; do $*; sleep 1; clear; done }

# Unti command returns 0, do command, clear, sleep
function ut() { clear && until $*; do sleep 1; clear; done }

alias .z='. ~/.zshrc'
