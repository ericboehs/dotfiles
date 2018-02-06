source ~/.vim/plug.vim
source ~/.vim/fzf.vim
source ~/.vim/keybindings.vim
source ~/.vim/macros.vim
source ~/.vim/lightline.vim
source ~/.vim/vroom.vim
source ~/.vim/vim-diminactive.vim
source ~/.vim/vim-tmux-runner.vim
source ~/.vim/vim-tmux-navigator.vim
source ~/.vim/ale.vim

set relativenumber                          " Show line numbers relative to each other
set number                                  " Show the current lines number w/ relative numbers around it
set noswapfile                              " Don't create annoying *.swp files
set wildmode=list:longest                   " Tab complete to longest common string, like bash
set showcmd                                 " Display an incomplete command in the lower right corner
set noshowmode                                " Show current mode down the bottom
set iskeyword+=\-                           " Auto complete words with dashes

autocmd FileType gitcommit set spell        " Turn on spell check in Git commits.

" Treat dashed words as whole words in stylesheets
autocmd Filetype css,scss,sass setlocal iskeyword+=-

" Searching
set hlsearch                                " Highlight searches
set incsearch                               " Highlight search results instantly
set ignorecase                              " Ignore case
set smartcase                               " Override 'ignorecase' option if the search contains upper case characters.

" Indentation
set shiftwidth=2                            " Number of spaces to use in each autoindent step
set tabstop=2                               " Two tab spaces
set softtabstop=2                           " Number of spaces to skip or insert when <BS>ing or <Tab>ing
set expandtab                               " Spaces instead of tabs for better cross-editor compatibility

" Color column at 120 characters
set colorcolumn=120
set textwidth=120

" Undo
if !isdirectory(expand("~/.vim/.undo/"))
  silent !mkdir -p ~/.vim/.undo/
endif
set undodir=$HOME/.vim/.undo
set undofile
set undolevels=1000
set undoreload=10000

" Colorscheme
silent! colorscheme solarized
highlight SignColumn ctermbg=8

" Set wildcard ignore for ctrlp and ack/ag
set wildignore+=*/tmp/*,vendor/bundle/*,*/build/*,*/Resources/*,*.so,*.swp,*.zip,*.png,*.jpg,*.jpeg,*.gif,.gitkeep

" Set ack.vim to use ag
if executable('ag')
  let g:ackprg = 'ag --vimgrep'
endif

if filereadable(expand("~/.vimrc.local"))
  source ~/.vimrc.local
endif
