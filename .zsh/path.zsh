# Make path unique
typeset -Ug path

path=(.git/safe/../../vendor/bundle/bin "$path[@]")
path=(.git/safe/../../node_modules/.bin "$path[@]")
path=(.git/safe/../../.bundle/bundle/bin "$path[@]")
path=(.git/safe/../../bin "$path[@]")
path=(~/bin "$path[@]")
path=(~/.local/bin "$path[@]")
path=(/Applications/Postgres.app/Contents/Versions/latest/bin "$path[@]")

cdpath=(~ ~/Code)

if [[ "$OSTYPE" == "darwin"* ]]; then
  export PATH="/opt/homebrew/opt/libxml2/bin:$PATH"
  export PATH="/Users/ericboehs/Code/ggerganov/whisper.cpp:$PATH"
  export OPENSSL_DIR="/opt/homebrew/opt/openssl@3"
fi
