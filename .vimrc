source ~/.vim/vundle.vim
source ~/.vim/keybindings.vim
source ~/.vim/lightline.vim

if filereadable(expand("~/.vimrc.local"))
  source ~/.vimrc.local
endif
