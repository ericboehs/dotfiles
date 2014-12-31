# Heroku
alias h='heroku'
hc() { heroku run bash "-i -c 'curl -s https://raw.githubusercontent.com/ericboehs/dotfiles/master/config/inputrc > ~/.inputrc; rails c'" $@ }

hs()  { heroku $@ -r staging }
hsr() { heroku run $@ -r staging }
hsc() { hc -r staging }

hp()  { heroku $@ -r production }
hpr() { heroku run $@ -r production }
hpc() { hc -r production }
