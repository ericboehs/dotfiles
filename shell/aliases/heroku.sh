# Heroku
alias h='heroku'
hs()  { heroku $@ -r staging }
hsr() { heroku run $@ -r staging }
hp()  { heroku $@ -r production }
hpr() { heroku run $@ -r production }
hq()  { heroku $@ -r qa }
hqr() { heroku run $@ -r qa }
