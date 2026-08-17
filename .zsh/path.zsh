# Make path unique
typeset -Ug path

path=(.git/safe/../../vendor/bundle/bin "$path[@]")
path=(.git/safe/../../node_modules/.bin "$path[@]")
path=(.git/safe/../../.bundle/bundle/bin "$path[@]")
path=(.git/safe/../../bin "$path[@]")
path=(~/bin "$path[@]")
path=(~/.local/bin "$path[@]")
# Guarded: on a Linux box this put a nonexistent /Applications path on PATH.
# Kept here rather than in the darwin block below so the ordering relative to
# ~/.local/bin and AUBE_HOME stays exactly as it was.
if [[ "$OSTYPE" == "darwin"* ]]; then
  path=(/Applications/Postgres.app/Contents/Versions/latest/bin "$path[@]")
fi

# aube: keep global packages + binaries under aube
export AUBE_HOME="$HOME/.local/share/aube"
path=("$AUBE_HOME" "$path[@]")

cdpath=(~ ~/Code)

if [[ "$OSTYPE" == "darwin"* ]]; then
  export PATH="/opt/homebrew/opt/libxml2/bin:$PATH"
  export PATH="/Users/ericboehs/Code/ggerganov/whisper.cpp:$PATH"
  export OPENSSL_DIR="/opt/homebrew/opt/openssl@3"
fi
