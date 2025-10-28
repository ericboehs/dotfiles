#!/bin/sh
# Installation script adopted from https://gist.github.com/sonots/4239842

set -e # Exit on any error

# Checkout dotfiles repo and cd (pushd) to it
mkdir -p ~/Code/ericboehs/
[[ -e ~/Code/ericboehs/dotfiles ]] || git clone https://github.com/ericboehs/dotfiles ~/Code/ericboehs/dotfiles
pushd ~/Code/ericboehs/dotfiles > /dev/null
mkdir -p ~/.ssh

# Make sure we're on the latest master and have the correct submodule versions
# git checkout master || echo
# git pull --rebase origin master || echo
git submodule init
git submodule update

# Install brew dependencies on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "-----> Installing Homebrew dependencies"
  brew install mise neovim git direnv lsd starship zoxide fzf zsh-autosuggestions gpg tmux ripgrep fd lua gh terminal-notifier
fi

# symlink all dotfiles into ~ (skip if they exist)
dotfiles="$(ls -a) .ssh/config"
for f in $dotfiles; do
  overwrite=false
  source_file=~/Code/ericboehs/dotfiles/$f
  target_file=~/$(dirname $f)/$(basename $f)

  # Skip these files
  [ $f = "." ]            && continue
  [ $f = ".." ]           && continue
  [ $f = ".ssh" ]         && continue
  [ $f = ".git" ]         && continue
  [ $f = ".gitignore" ]   && continue
  [ $f = ".gitmodules" ]  && continue
  [ $f = "bootstrap.sh" ] && continue
  [ $f = "README.md" ]    && continue

  if [ $f = ".gitconfig.private.example" ]; then
    [[ $USER = "ericboehs" ]] && ln -fs $source_file ~/.gitconfig.private
    continue
  fi

  if [ $f = ".gitignore.global" ]; then
    ln -fs $source_file ~/.gitignore
    continue
  fi

  if [ -e ~/$f ]; then
    test $(readlink $source_file) = $(readlink ~/Code/ericboehs/dotfiles/$f) && continue

    if [ "$FORCE_OVERWRITE" == "true" ]; then
      overwrite=true
    else
      read -p "~/$f exists. Overwrite? [[y]n]" yn
      case $yn in
        [Nn]* ) continue;;
        * ) overwrite=true;;
      esac
    fi

    if [ overwrite ]; then
      ln -fs $source_file ~/
    fi
  else
    echo "-----> Linking $source_file"
    ln -fs $source_file $target_file
  fi
done

# Symlink neovim config
mkdir -p ~/.config
echo "-----> Linking neovim config"
ln -fs $PWD/.config/nvim ~/.config/nvim

popd > /dev/null

echo "-----> All done. Enjoy your shell."
