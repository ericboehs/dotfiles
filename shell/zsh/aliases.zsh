## Pipe Aliases (Global)
alias -g L='|less'
alias -g G='|grep'
alias -g T='|tail'
alias -g H='|head'
alias -g W='|wc -l'
alias -g S='|sort'
alias -g K='|ruby -e "require %Q(open-uri); puts URI::encode STDIN.read" | while read i; do kiku $i; done'

# Looks for "2 points" then sums STDIN on the index of the integer (column); only works for single digit points (0, 2, 4, 8)
alias -g POINTS="|ruby -e 's=STDIN.to_a;i=s.grep(/point/)[0].index /[0-9]+ point/;p s.map{|l|l[i].to_i}.reduce(&:+)'"

