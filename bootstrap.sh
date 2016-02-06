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
    ln -s $source_file $target_file
  fi
done

# Install fzf
yes no | ~/.fzf/install > /dev/null
git checkout .zshrc

# Install vim plugins
vim -u NONE -c ':BundleInstall!' -c ':qa!'

popd > /dev/null

echo "-----> All done. Enjoy your shell."
