set rtp+=~/.vim/bundle/Vundle.vim
call vundle#begin()

Plugin 'junegunn/fzf'
Plugin 'itchyny/lightline.vim'
Plugin 'edkolev/tmuxline.vim'
Plugin 'benmills/vimux'
Plugin 'rking/ag.vim'

Plugin 'tpope/vim-sensible'
Plugin 'tpope/vim-fugitive'
Plugin 'tpope/vim-eunuch'
Plugin 'tpope/vim-repeat'

" Ruby/Rails
Plugin 'tpope/vim-rails'
Plugin 'skalnik/vim-vroom'

" Editing
Plugin 'godlygeek/tabular'
Plugin 'tomtom/tcomment_vim'
Plugin 'tpope/vim-surround'
Plugin 'bronson/vim-trailing-whitespace'
Plugin 'sjl/gundo.vim'
Plugin 'tommcdo/vim-exchange'
Plugin 'tpope/vim-commentary'

" Languages
Plugin 'slim-template/vim-slim'
Plugin 'kchmck/vim-coffee-script'
Plugin 'tpope/vim-cucumber'

" Colors
Plugin 'altercation/vim-colors-solarized'

call vundle#end()
