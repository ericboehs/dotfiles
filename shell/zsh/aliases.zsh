## Pipe Aliases (Global)
alias -g RCL=" > .git/last_pr_output | tail -1 | tr -d '\\n' | rpbcopy && cat .git/last_pr_output && rm .git/last_pr_output"
alias -g L='|less'
alias -g G='|grep'
alias -g T='|tail'
alias -g H='|head'
alias -g W='|wc -l'
alias -g S='|sort'
alias -g V='|view -'

# Looks for "2 points" then sums STDIN on the index of the integer (column); only works for single digit points (0, 2, 4, 8)
alias -g POINTS="|ruby -e 's=STDIN.to_a;i=s.grep(/[^0] point/)[0]; i=i.index /[0-9]+ point/ if i;p !i ? 0 : s.map{|l|l[i].to_i}.reduce(&:+)'"
alias -g P=POINTS

# Columnize ghi list output
alias -g COL='| tail +2 | sed "s/@$//" | sed "s/[0-9]\ $//" | sed "s/[0-9]$//" | column -s "[]" -t'

# While true do command, clear, sleep
function wt() { while; do $*; sleep 1; clear; done }

# Unti command returns 0, do command, clear, sleep
function ut() { clear && until $*; do sleep 1; clear; done }

alias .z='. ~/.zshrc'
