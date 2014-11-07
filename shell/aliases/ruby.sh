# bundle exec
alias b='bundle'
alias be='bundle exec'
alias bi='bundle install -j8 --path vendor/bundle --binstubs vendor/bundle/bin'

# Switch ruby versions with homebrew. See: https://gist.github.com/ericboehs/5329013
rbv () { brew switch ruby $(brew switch ruby list 2>&1 |tail -1|cut -d\  -f3-|tr -d ','|tr ' ' "\n" | grep "^$1" | head -1) && source ~/.zsh/config }

# Lookup gem's latest version number
gemv() { gem sea -r "^$1$"|tail -1|cut -f2 -d' '|tr -d '()' }

# Gems
alias bp='bundle exec gem pristine'

# Rails
alias tlog='tail -f log/development.log'
alias rl='rails'
alias rg='rails g'
alias rgm='rails g migration'
alias ss='spring stop'
alias ssr='SKIP_SLOW=true rake'

# Rake
alias rk='rake'
alias rkn='rake notes'
alias rdm='rake db:migrate'
