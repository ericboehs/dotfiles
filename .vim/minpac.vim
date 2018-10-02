if &compatible
  set nocompatible
endif

if exists('*minpac#init')
  call minpac#init()
  call minpac#add('k-takata/minpac', {'type': 'opt'})

  " The great tpope
  call minpac#add('tpope/vim-sensible')
  call minpac#add('tpope/vim-commentary')
  call minpac#add('tpope/vim-eunuch')

  " Colorscheme
  call minpac#add('altercation/vim-colors-solarized')
  call minpac#add('itchyny/lightline.vim')

  " Tmux
  call minpac#add('christoomey/vim-tmux-runner')

  " Language
  call minpac#add('w0rp/ale')
endif

command! PackUpdate packadd minpac | source $MYVIMRC | call minpac#update('', {'do': 'call minpac#status()'})
command! PackClean  packadd minpac | source $MYVIMRC | call minpac#clean()
command! PackStatus packadd minpac | source $MYVIMRC | call minpac#status()
