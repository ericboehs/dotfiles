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
  brew install mise neovim git direnv lsd starship zoxide fzf zsh-autosuggestions gpg tmux ripgrep fd lua gh terminal-notifier delta

  # Setup iTerm2 with Catppuccin Mocha theme and Inconsolata Nerd Font
  # Check if Inconsolata Nerd Font is already installed
  if [ ! -f ~/Library/Fonts/InconsolataNerdFontMono-Regular.ttf ]; then
    echo "-----> Setting up Inconsolata Nerd Font"
    TEMP_DIR=$(mktemp -d)

    echo "-----> Downloading Inconsolata Nerd Font..."
    curl -fsSL -o "$TEMP_DIR/Inconsolata.zip" https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Inconsolata.zip
    unzip -q "$TEMP_DIR/Inconsolata.zip" -d "$TEMP_DIR"

    echo "-----> Installing fonts..."
    mkdir -p ~/Library/Fonts
    cp "$TEMP_DIR"/*.ttf ~/Library/Fonts/ 2>/dev/null || true

    rm -rf "$TEMP_DIR"
    echo "-----> Inconsolata Nerd Font installed"
  else
    echo "-----> Inconsolata Nerd Font already installed"
  fi

  # Check if Catppuccin Mocha color scheme is already imported
  if ! plutil -extract "Custom Color Presets"."Catppuccin Mocha" xml1 -o - ~/Library/Preferences/com.googlecode.iterm2.plist >/dev/null 2>&1; then
    echo "-----> Setting up Catppuccin Mocha color scheme"
    TEMP_DIR=$(mktemp -d)

    echo "-----> Downloading Catppuccin Mocha color scheme..."
    curl -fsSL -o "$TEMP_DIR/Catppuccin Mocha.itermcolors" "https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/schemes/Catppuccin%20Mocha.itermcolors"

    echo "-----> Importing color scheme (iTerm2 will briefly open)..."
    open "$TEMP_DIR/Catppuccin Mocha.itermcolors"
    sleep 2

    rm -rf "$TEMP_DIR"
    echo "-----> Catppuccin Mocha color scheme imported"
  else
    echo "-----> Catppuccin Mocha color scheme already imported"
  fi
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

# Symlink .config directories
mkdir -p ~/.config
echo "-----> Linking neovim config"
ln -fns $PWD/.config/nvim ~/.config/nvim
echo "-----> Linking mise config"
mkdir -p ~/.config/mise
ln -fs $PWD/.config/mise/config.toml ~/.config/mise/config.toml

# Install TPM (Tmux Plugin Manager) and plugins
if [ ! -d ~/.tmux/plugins/tpm ]; then
  echo "-----> Installing TPM (Tmux Plugin Manager)"
  git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
  echo "-----> Installing tmux plugins"
  ~/.tmux/plugins/tpm/bin/install_plugins
else
  echo "-----> TPM already installed"
fi

popd > /dev/null

echo "-----> All done. Enjoy your shell."
