set rtp+=~/.vim/bundle/Vundle.vim
call vundle#begin()

Plugin 'junegunn/fzf'
Plugin 'itchyny/lightline.vim'
Plugin 'edkolev/tmuxline.vim'
Plugin 'benmills/vimux'
Plugin 'rking/ag.vim'
Plugin 'mattboehm/vim-unstack'

Plugin 'tpope/vim-eunuch'
Plugin 'tpope/vim-fugitive'
Plugin 'tpope/vim-repeat'
Plugin 'tpope/vim-sensible'
Plugin 'tpope/vim-unimpaired'

" Ruby/Rails
Plugin 'tpope/vim-rails'
Plugin 'skalnik/vim-vroom'

" Tmux
Plugin 'christoomey/vim-tmux-navigator'
Plugin 'christoomey/vim-tmux-runner'

" Editing
Plugin 'godlygeek/tabular'
Plugin 'tomtom/tcomment_vim'
Plugin 'tpope/vim-surround'
Plugin 'bronson/vim-trailing-whitespace'
Plugin 'tommcdo/vim-exchange'
Plugin 'tpope/vim-commentary'
Plugin 'mbbill/undotree'
Plugin 'henrik/vim-indexed-search'

" Languages
Plugin 'slim-template/vim-slim'
Plugin 'kchmck/vim-coffee-script'
Plugin 'tpope/vim-cucumber'

" Colors
Plugin 'altercation/vim-colors-solarized'

call vundle#end()
