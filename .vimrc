source ~/.vim/vundle.vim
source ~/.vim/keybindings.vim

if filereadable(expand("~/.vimrc.local"))
  source ~/.vimrc.local
endif
