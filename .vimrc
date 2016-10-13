source ~/.vim/vundle.vim
source ~/.vim/fzf.vim
source ~/.vim/keybindings.vim
source ~/.vim/macros.vim
source ~/.vim/lightline.vim
source ~/.vim/vroom.vim
source ~/.vim/vim-diminactive.vim
source ~/.vim/vim-tmux-runner.vim
source ~/.vim/vim-tmux-navigator.vim
source ~/.vim/vim-unstack.vim

set t_Co=256                                " Support for xterm with 256 colors (gets overriden in .gvimrc)
set relativenumber                          " Show line numbers relative to each other
set number                                  " Show the current lines number w/ relative numbers around it
set ruler                                   " Show ruler
set listchars=trail:.,tab:>-,eol:¬          " Change the invisible characters
set noswapfile                              " Don't create annoying *.swp files
set scrolloff=5                             " Start scrolling the file 5 lines before the end of the window
set spelllang=en_us                         " Set default spelling language to English
set hidden                                  " Allow hiding buffers with unsaved changes
set wildmenu                                " Make tab completion act more like bash
set wildmode=list:longest                   " Tab complete to longest common string, like bash
set showcmd                                 " Display an incomplete command in the lower right corner
set showmode                                " Show current mode down the bottom
set laststatus=2                            " Always show the status line
set history=10000
set autoread
set noerrorbells visualbell t_vb=           " No more error bells

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
set autoindent                              " Keep the indent when creating a new line
set smarttab                                " Use shiftwidth and softtabstop to insert or delete (on <BS>) blanks
set cindent                                 " Recommended seting for automatic C-style indentation

" Color column at 110 characters
set colorcolumn=110
set textwidth=110

" Undo
if !isdirectory(expand("~/.vim/.undo/"))
  silent !mkdir -p ~/.vim/.undo/
endif
set undodir=$HOME/.vim/.undo
set undofile
set undolevels=1000
set undoreload=10000

" Colorscheme
syntax enable
colorscheme solarized
highlight SignColumn ctermbg=8

" Set wildcard ignore for ctrlp and ack/ag
set wildignore+=*/tmp/*,vendor/bundle/*,*/build/*,*/Resources/*,*.so,*.swp,*.zip,*.png,*.jpg,*.jpeg,*.gif,.gitkeep

if filereadable(expand("~/.vimrc.local"))
  source ~/.vimrc.local
endif
