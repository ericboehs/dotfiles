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

# Zeus needs to be in the :test bundler group but zeus binstubs are broken for some reason
# This will take bundler's binstub dir out of the path when you run zeus
alias zeus='$(which -a zeus|grep -m1 -v bundle)'
