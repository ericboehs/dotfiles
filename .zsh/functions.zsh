alias ls=lsd

opsi() {
  eval $(op signin)
  sed -i '' '/export OP_SESSION_my/d' ~/.zshrc.local
  env | grep OP_SESSION_my | sed -e 's/^/export /' >> ~/.zshrc.local
}

mfa() {
  source ~/Code/va.ghe.com/software/devops/utilities/issue_mfa.sh Eric.Boehs $1
  sed -i '' '/export AWS_/d' ~/.zshrc.local
  env | grep AWS_ | sed -e 's/^/export /' >> ~/.zshrc.local
}

# gcd/gvi: cd to a repo from its URL (github.com/ericboehs/gcd, cloned by bootstrap)
[[ -f ~/Code/github.com/ericboehs/gcd/gcd.sh ]] && source ~/Code/github.com/ericboehs/gcd/gcd.sh
