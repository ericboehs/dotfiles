#!/bin/sh
# Installation script adopted from https://gist.github.com/sonots/4239842

set -e

[[ -e ~/.dotfiles ]] || git clone https://github.com/ericboehs/dotfiles ~/.dotfiles
pushd ~/.dotfiles > /dev/null

git checkout master || echo
git pull --rebase origin master || echo
git submodule init
git submodule update

mkdir -p ~/.ssh

dotfiles="$(ls -a) .ssh/config"
for f in $dotfiles; do
  overwrite=false
  source_file=~/.dotfiles/$f
  target_file=~/$(dirname $f)/$(basename $f)

  [ $f = "." ]            && continue
  [ $f = ".." ]           && continue
  [ $f = ".ssh" ]         && continue
  [ $f = ".git" ]         && continue
  [ $f = ".gitignore" ]   && continue
  [ $f = ".gitmodules" ]  && continue
  [ $f = "bootstrap.sh" ] && continue
  [ $f = "README.md" ]    && continue

  if [ -e ~/$f ];then
    test $(readlink $source_file) = $(readlink ~/.dotfiles/$f) && continue

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

if [ ! -d ~/.asdf ];then
  echo "-----> Install asdf-vm"
  git clone https://github.com/asdf-vm/asdf.git ~/.asdf
  cd ~/.asdf
  git checkout "$(git describe --abbrev=0 --tags)"

  source ~/.asdf/asdf.sh

  # Install node
  asdf plugin-add nodejs
  bash ~/.asdf/plugins/nodejs/bin/import-release-team-keyring
  asdf install nodejs 8.12.0

  # Install ruby
  asdf plugin-add ruby
  asdf install ruby 2.6.5
  asdf global ruby 2.6.5
fi

# Install vim plugins
vim -c ':silent !echo' -c ':PackUpdate' -c ':qa!'

popd > /dev/null

echo "-----> All done. Enjoy your shell."
