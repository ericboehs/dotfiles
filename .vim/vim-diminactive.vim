" Enable diminactive plugin
let g:diminactive_enable_focus = 1

" Toggle relative numbers  on FocusLost
autocmd FocusLost * :set number norelativenumber

" Using vim-tmux-navigator bindings, on FocusLost ^[[O was left behind
autocmd FocusLost * silent redraw!
autocmd FocusGained * :set number relativenumber

" Toggle relative numbers in insert mode
autocmd InsertEnter * :set number norelativenumber
autocmd InsertLeave * :set number relativenumber
