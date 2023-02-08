if &compatible
  set nocompatible
endif

function! PackInit() abort
  packadd minpac

  " The great tpope
  call minpac#add('tpope/vim-commentary')
  call minpac#add('tpope/vim-eunuch')
  call minpac#add('tpope/vim-fugitive')
  call minpac#add('tpope/vim-rhubarb')
  call minpac#add('tpope/vim-sensible')
  call minpac#add('tpope/vim-unimpaired')
  call minpac#add('junegunn/goyo.vim')

  " Colorscheme
  call minpac#add('edkolev/tmuxline.vim')
  call minpac#add('itchyny/lightline.vim')
  call minpac#add('projekt0n/github-nvim-theme')

  " Language
  call minpac#add('mfussenegger/nvim-lint')
  " call minpac#add('neoclide/coc.nvim', { 'branch': 'release' })
  call minpac#add('neovim/nvim-lspconfig')
  call minpac#add('nvim-lua/completion-nvim')

  " Tmux
  call minpac#add('blueyed/vim-diminactive')
  call minpac#add('christoomey/vim-tmux-navigator')
  call minpac#add('christoomey/vim-tmux-runner')
  call minpac#add('tmux-plugins/vim-tmux-focus-events')

  " Project Finding
  call minpac#add('nvim-lua/plenary.nvim')
  call minpac#add('nvim-treesitter/nvim-treesitter')
  call minpac#add('nvim-telescope/telescope.nvim')
  call minpac#add('nvim-telescope/telescope-fzy-native.nvim')

  " Misc
  call minpac#add('github/copilot.vim')
  call minpac#add('henrik/vim-indexed-search')
  "call minpac#add('junegunn/fzf')
  "call minpac#add('junegunn/fzf.vim')
  call minpac#add('mattn/calendar-vim')
  call minpac#add('ntpeters/vim-better-whitespace')
  call minpac#add('vimwiki/vimwiki', { 'branch': 'dev' })
endfunction

command! PackUpdate call PackInit() | call minpac#update()
command! PackClean  call PackInit() | call minpac#clean()
command! PackStatus packadd minpac | call minpac#status()
