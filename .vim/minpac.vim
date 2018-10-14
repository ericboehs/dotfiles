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
  call minpac#add('tpope/vim-repeat')
  call minpac#add('tpope/vim-surround')
  call minpac#add('tpope/vim-unimpaired')

  " Tmux
  call minpac#add('christoomey/vim-tmux-navigator')
  call minpac#add('christoomey/vim-tmux-runner')
  call minpac#add('tmux-plugins/vim-tmux-focus-events')
  call minpac#add('blueyed/vim-diminactive')

  " Editing
  call minpac#add('henrik/vim-indexed-search')

  " Language
  call minpac#add('w0rp/ale')

  " Colorscheme
  call minpac#add('altercation/vim-colors-solarized')
  call minpac#add('itchyny/lightline.vim')
endif

command! PackUpdate packadd minpac | source $MYVIMRC | call minpac#update('', {'do': 'call minpac#status()'})
command! PackClean  packadd minpac | source $MYVIMRC | call minpac#clean()
command! PackStatus packadd minpac | source $MYVIMRC | call minpac#status()
