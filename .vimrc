source ~/.vim/ale.vim
source ~/.vim/minpac.vim
source ~/.vim/fzf.vim
source ~/.vim/keybindings.vim
source ~/.vim/coc.vim
source ~/.vim/dark-mode.vim
source ~/.vim/lightline.vim
source ~/.vim/vim-diminactive.vim
source ~/.vim/vim-tmux-runner.vim
source ~/.vim/vim-tmux-navigator.vim
source ~/.vim/vim-wiki.vim

set relativenumber                          " Show line numbers relative to each other
set number                                  " Show the current lines number w/ relative numbers around it
set noswapfile                              " Don't create *.swp files
set wildmode=list:longest                   " Tab complete to longest common string, like bash
set showcmd                                 " Display an incomplete command in the lower right corner
set iskeyword+=\-                           " Auto complete words with dashes
set mouse=a                                 " Allow scrolling/visual mode with mouse; Cmd-R to disable in Terminal
set nowrap                                  " Turn off line wrapping; use yow to turn back on

if has("gui_macvim")
  set guioptions=                           " Removes scroll bars in macvim
  let macvim_hig_shift_movement = 1         " Allow VISUAL selections via Shift+Arrows
  " set selectmode=                           " Use VISUAL mode instead of SELECT mode (for shift_movements)
endif

autocmd FileType gitcommit set spell                 " Turn on spell check in Git commits.
autocmd Filetype css,scss,sass setlocal iskeyword+=- " Treat dashed words as whole words in stylesheets

" Searching
set hlsearch      " Highlight searches
set ignorecase    " Ignore case
set smartcase     " Override 'ignorecase' option if the search contains upper case characters.

" Indentation
set shiftwidth=2  " Number of spaces to use in each autoindent step
set tabstop=2     " Two tab spaces
set softtabstop=2 " Number of spaces to skip or insert when <BS>ing or <Tab>ing
set expandtab     " Spaces instead of tabs for better cross-editor compatibility

" Undo
if !isdirectory(expand("~/.vim/.undo/"))
  silent !mkdir -p ~/.vim/.undo/
endif
set undodir=$HOME/.vim/.undo
set undofile
set undolevels=1000
set undoreload=10000

" Color column at 120 characters
set colorcolumn=120

" Colorscheme
if has("gui_macvim")
  let ayucolor="light"
  silent! colorscheme ayu
  set laststatus=1
  set guifont=Menlo-Regular:h18
  set norelativenumber
  set nonumber
else
  silent! colorscheme solarized
endif
highlight SignColumn ctermbg=8
let g:tmuxline_separators = { 'left' : '', 'left_alt': '', 'right' : '', 'right_alt' : '' }

if filereadable(expand("~/.vimrc.local"))
  source ~/.vimrc.local
endif
