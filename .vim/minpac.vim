if &compatible
  set nocompatible
endif

if exists('*minpac#init')
  call minpac#init()
  call minpac#add('k-takata/minpac', {'type': 'opt'})

  " The great tpope
  call minpac#add('tpope/vim-sensible')
  " call minpac#add('tpope/vim-bundler') " Causes long boot on rails projects
  call minpac#add('tpope/vim-commentary')
  call minpac#add('tpope/vim-dadbod')
  call minpac#add('tpope/vim-dispatch')
  call minpac#add('tpope/vim-eunuch')
  call minpac#add('tpope/vim-fugitive')
  call minpac#add('tpope/vim-heroku')
  call minpac#add('tpope/vim-markdown')
  call minpac#add('tpope/vim-rails')
  call minpac#add('tpope/vim-ragtag')
  call minpac#add('tpope/vim-rhubarb')
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
  call minpac#add('mattn/emmet-vim')
  call minpac#add('justinmk/vim-sneak')
  call minpac#add('tommcdo/vim-exchange')
  call minpac#add('neoclide/coc.nvim', { 'branch': 'release' })

  " Language
  call minpac#add('w0rp/ale')
  call minpac#add('mxw/vim-jsx')

  " Rails/Rails
  call minpac#add('ngmy/vim-rubocop')
  call minpac#add('ecomba/vim-ruby-refactoring')

  " Colorscheme
  call minpac#add('ayu-theme/ayu-vim')
  call minpac#add('altercation/vim-colors-solarized')
  call minpac#add('itchyny/lightline.vim')
  call minpac#add('edkolev/tmuxline.vim')

  " Misc
  call minpac#add('vimwiki/vimwiki', { 'branch': 'dev' })
  call minpac#add('junegunn/fzf')
  call minpac#add('junegunn/fzf.vim')
endif

command! PackUpdate packadd minpac | source $MYVIMRC | call minpac#update('', {'do': 'call minpac#status()'})
command! PackClean  packadd minpac | source $MYVIMRC | call minpac#clean()
command! PackStatus packadd minpac | source $MYVIMRC | call minpac#status()
