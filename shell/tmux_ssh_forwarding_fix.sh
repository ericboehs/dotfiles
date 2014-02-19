# Fix SSH_AUTH_SOCK to a predicatable locaiton
# SOCK="/tmp/ssh-agent-$USER-screen"
# if test $SSH_AUTH_SOCK && [ $SSH_AUTH_SOCK != $SOCK ]
# then
#   ln -sf $SSH_AUTH_SOCK $SOCK
#   # readlink $SSH_AUTH_SOCK > /dev/null || sudo chmod -R g+rwx $(dirname $SSH_AUTH_SOCK)
#   readlink $SSH_AUTH_SOCK > /dev/null || chmod -R g+rwx $(dirname $SSH_AUTH_SOCK)
#   export SSH_AUTH_SOCK=$SOCK
# fi
