# Make path unique
typeset -Ug path

# Add current directory's bin, node_modules/.bin and vendor/bundle/bin directories to path safely
path=(.git/safe/../../vendor/bundle/bin "$path[@]")
path=(.git/safe/../../node_modules/.bin "$path[@]")
path=(.git/safe/../../.bundle/bundle/bin "$path[@]")
path=(.git/safe/../../bin "$path[@]")
path=(~/bin "$path[@]")
path=(~/.local/bin "$path[@]")
path=(/Applications/Postgres.app/Contents/Versions/latest/bin "$path[@]")

# Add ~ and ~/Code to cdpath
cdpath=(~ ~/Code)

# Add direnv
eval "$(direnv hook zsh)"
