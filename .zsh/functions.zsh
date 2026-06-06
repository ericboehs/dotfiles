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

# --- Steer npm/npx toward aube (warn + show equivalent, confirm before running) ---
# You've switched to aube; these nudge toward the aube equivalent and ask before
# running the real tool. Silent bypass: `command npm …` / `command npx …`.
# Non-interactive/piped invocations pass straight through so scripts don't hang.
_aube_npm_hint() {
  local sub=$1; shift
  case $sub in
    i|in|install|isntall|add)  (( $# )) && echo "  aube add $*" || echo "  aube install" ;;
    ci|clean-install)          echo "  aube ci" ;;
    run|run-script)            echo "  aube run $*" ;;
    t|test)                    echo "  aube test $*" ;;
    start)                     echo "  aube start $*" ;;
    x|exec)                    echo "  aube exec $*" ;;
    rm|r|un|uninstall|remove)  echo "  aube remove $*" ;;
    up|update|upgrade)         echo "  aube update $*" ;;
    init)                      echo "  aube init $*" ;;
    create)                    echo "  aube create $*" ;;
    ls|list)                   echo "  aube list $*" ;;
    audit)                     echo "  aube audit $*" ;;
    '')                        echo "  aube <command>" ;;
    *)                         echo "  aube $sub $*" ;;
  esac
}

npm() {
  [[ -t 0 ]] || { command npm "$@"; return; }
  {
    print "⚠️  You've switched to aube. Equivalent:"
    _aube_npm_hint "$@"
    print "   (silent bypass: command npm $*)"
  } >&2
  if read -q "?Run real npm anyway? [y/N] "; then
    print "" >&2
    command npm "$@"
  else
    print "\n↳ skipped — use the aube command above." >&2
    return 130
  fi
}

npx() {
  [[ -t 0 ]] || { command npx "$@"; return; }
  {
    print "⚠️  You've switched to aube. Equivalent:"
    print "  aubx $*    (one-off run; = aube dlx)   |   aube exec $*   (local bin)"
    print "   (silent bypass: command npx $*)"
  } >&2
  if read -q "?Run real npx anyway? [y/N] "; then
    print "" >&2
    command npx "$@"
  else
    print "\n↳ skipped — use 'aubx' above." >&2
    return 130
  fi
}
