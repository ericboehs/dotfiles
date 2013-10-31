# bundle exec
alias b='bundle'
alias be='bundle exec'
alias bi='bundle install -j8 --path vendor/bundle --binstubs vendor/bundle/bin'

# Switch ruby versions with homebrew. See: https://gist.github.com/ericboehs/5329013
rbv () { brew switch ruby $(brew switch ruby list 2>&1 |tail -1|cut -d\  -f3-|tr -d ','|tr ' ' "\n" | grep "^$1" | head -1) && source ~/.zsh/config }

# Lookup gem's latest version number
gemv() { gem sea -r "^$1$"|tail -1|cut -f2 -d' '|tr -d '()' }

# Rails
alias tlog='tail -f log/development.log'
alias ttr='touch tmp/restart.txt'
alias bs='bin/setup'

# Zeus
alias kr='killall ruby'
alias kz='killall zeus-darwin-amd64'
alias wtzs='while; do zeus start||rm .zeus.sock; sleep 1; clear; done'
utzt() { clear && until zeus test ${1:="test"}; do echo 'Test(s) failed. Trying again.'; done }
alias ze='zeus'
alias zs='zeus start'
alias zdb='zeus dbconsole'
alias zrr='zeus runner'
alias zg='zeus generate'
alias zrc='zeus console'
alias zd='zeus destroy'
alias zrs='zeus server'
alias zr='zeus rake'
alias zt='zeus test'
alias ztt='zeus test test'

# Checkout a PR by id (given as first/only arg), run bin_setup, restart zeus processes, restart ruby (guard) proceses, run the test suite with zeus and then open localhost
prco(){ tmux -S /tmp/tmux-pair-session send -R -t $2:2.1 git\ fetch\ origin\ pull/$1/head:pull/$1/head\;gco\ -b pull/$1/head\|\|gco\ pull/$1/head\;bs\;kr\;kz\;sleep\ 2\;ztt\;open\ http://localhost:3000 ENTER }

# Checkout a branch (given as first/only arg), run bin_setup, restart zeus processes, restart ruby (guard) proceses, run the test suite with zeus and then open localhost
gto(){ tmux send -t 2.1 gco\ $1\;bs\;kr\;kz\;sleep\ 2\;ztt\;open\ http://localhost:3000 ENTER }
