#!/bin/sh
# Installation script adopted from https://gist.github.com/sonots/4239842

set -e # Exit on any error

# Checkout dotfiles repo and cd (pushd) to it
mkdir -p ~/Code/ericboehs/
[[ -e ~/Code/ericboehs/dotfiles ]] || git clone https://github.com/ericboehs/dotfiles ~/Code/ericboehs/dotfiles
pushd ~/Code/ericboehs/dotfiles > /dev/null
mkdir -p ~/.ssh

# Make sure we're on the latest master and have the correct submodule versions
git checkout master || echo
git pull --rebase origin master || echo
git submodule init
git submodule update

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

# Configure nvim
mkdir -p ~/.config
ln -fs ~/.vim ~/.config/nvim

# Configure asdf if it doesn't exists and install ruby and node
if [ ! -d ~/.asdf ]; then
  echo "-----> Install asdf-vm"
  git clone https://github.com/asdf-vm/asdf.git ~/.asdf
  cd ~/.asdf
  git checkout "$(git describe --abbrev=0 --tags)"

  source ~/.asdf/asdf.sh

  # Install node and yarn
  asdf plugin-add nodejs
  arch -x86_64 asdf install nodejs 18.15.0
  asdf global nodejs  18.15.0
  npm install -g yarn

  # Install ruby
  asdf plugin-add ruby
  asdf install ruby 3.2.2
  asdf global ruby 3.2.2
fi

# Install nvim plugins
nvim -c ':silent !echo' -c ':PackUpdate' -c ':qa!'

popd > /dev/null

echo "-----> All done. Enjoy your shell."
