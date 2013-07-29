# bundle exec
alias b='bundle'
alias be='bundle exec'
alias bi='bundle install --path vendor/bundle --binstubs vendor/bundle/bin'

# Switch ruby versions with homebrew. See: https://gist.github.com/ericboehs/5329013
rbv () { brew switch ruby $(brew switch ruby list 2>&1 |tail -1|cut -d\  -f3-|tr -d ','|tr ' ' "\n" | grep "^$1" | head -1) && source ~/.zsh/config }

# Lookup gem's latest version number
gemv() { gem sea -r "^$1$"|tail -1|cut -f2 -d' '|tr -d '()' }

# Rails
alias tlog='tail -f log/development.log'
alias ttr='touch tmp/restart.txt'

# Zeus
alias kr='killall ruby'
alias kz='killall zeus-darwin-amd64'
alias wtzs='while; do zeus start||rm .zeus.sock; sleep 1; clear; done'
alias wtzrs='while; do zeus server; sleep 1; clear; done'
alias wtzrc='while; do zeus console; sleep 1; clear; done'
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
