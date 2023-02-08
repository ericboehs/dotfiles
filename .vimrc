source ~/.vim/minpac.vim
"source ~/.vim/fzf.vim
source ~/.vim/keybindings.vim
luafile ~/.vim/nvim-lint.lua
" source ~/.vim/coc.vim
source ~/.vim/lightline.vim
source ~/.vim/gui.vim
source ~/.vim/vim-diminactive.vim
source ~/.vim/vim-tmux-runner.vim
source ~/.vim/vim-tmux-navigator.vim
source ~/.vim/vim-wiki.vim

set noswapfile                              " Don't create *.swp files (for vanilla vim)
set mouse=a                                 " Allow mouse interaction; Cmd-R to disable in Terminal
" set wildmode=list:longest                   " Tab complete to longest common string, like bash
" set iskeyword+=\-                           " Auto complete words with dashes
" set nowrap                                  " Turn off line wrapping; use yow to turn back on

autocmd FileType gitcommit set spell                 " Turn on spell check in Git commits.
" autocmd Filetype css,scss,sass setlocal iskeyword+=- " Treat dashed words as whole words in stylesheets

" Searching
set ignorecase " Ignore case
set smartcase  " Override 'ignorecase' option if the search contains upper case characters.

" Indentation
set shiftwidth=2  " Number of spaces to use in each autoindent step

" Undo
if !isdirectory(expand("~/.vim/.undo/"))
  silent !mkdir -p ~/.vim/.undo/
endif
set undodir=$HOME/.vim/.undo
set undofile
set undolevels=10000
set undoreload=10000

" Color column at 120 characters
set colorcolumn=120

" Colorscheme
if !has("gui_macvim")
  autocmd VimEnter * call timer_start(10, { tid -> execute('colorscheme github_light')})
endif
let g:better_whitespace_guicolor='pink'

if filereadable(expand("~/.vimrc.local"))
  source ~/.vimrc.local
endif
