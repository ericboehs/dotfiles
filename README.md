# ~/.dotfiles

My dotfiles tuned for zsh and OS X.

## Installation
``` sh
bash -c "$(curl -sL https://raw.github.com/ericboehs/dotfiles/master/bootstrap.sh)"
```

And then configure git:
``` sh
cp ~/.dotfiles/.gitconfig.private.example ~/.gitconfig.private
$EDITOR ~/.gitconfig.private
```

Also install zsh and `chsh` your shell to it and use the Solarized color scheme (iTerm or Terminal).

## What's in the box?

### .fzf and .zsh/fzf.zsh
https://github.com/junegunn/fzf

General purpose fuzzy finder. Find files, command history and more.

Usage: `Ctrl-R` and `Ctrl-T` in zsh. `Ctrl-P` in vim.

### .tmux and .tmux.conf
Terminal multiplexer. You can create persisted sessions with multiple tabs and panes for your projects.

Prefix is set to ``` ` ``` and to type a ``` ` ``` use ``` \` ```.

UI Customized with [tmuxline.vim](https://github.com/edkolev/tmuxline.vim) and [lightline.vim](https://github.com/itchyny/lightline.vim).

`bin/utcdate` is shown in the bottom right of the tmux status line.

TODO: Document other tmux settings and keybindings (e.g. resizing, switching panes, zooming, scrolling, searching, copy/pasting, last window, etc)

### .vim and .vimrc

### .zsh and .zshrc
Includes [pure prompt](https://github.com/sindresorhus/pure), [zsh-syntax-highlighting](https://github.com/zsh-users/zsh-syntax-highlighting) and some tidbits (tab completion) from [slim.zsh](https://github.com/changs/slimzsh).

I'm using abbreviations instead of aliases. Pressing `<space>` or `<enter>` will auto expand any abbreviation. See [abbreviations.zsh](https://github.com/ericboehs/dotfiles/blob/master/.zsh/abbreviations.zsh) for a list of abbreviations. There is currently a [bug](https://github.com/ericboehs/dotfiles/issues/13) where expansion happens unexpectedly mid command (especially noticable for `l` and `g`. See ticket for workaround.

To enter vi-mode, press `jk`. Vi mode is indicated by a `❯❯` prompt. Emacs bindings are still in place so if you don't like vi mode, just don't press `jk`.

TODO: Document other zsh settings

### bootstrap.sh
Used to install and update dotfiles to this repo.
