# Automatically/easily switch ruby versions via chruby
source /usr/local/opt/chruby/share/chruby/chruby.sh
# source /usr/local/opt/chruby/share/chruby/auto.sh # Unfortunately auto.sh clashes with .git/safe
chruby $(cat ~/.ruby-version) # Instead source .ruby-version manually
