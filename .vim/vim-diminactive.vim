" Enable diminactive plugin
let g:diminactive_enable_focus = 1

" Toggle relative numbers  on FocusLost
autocmd FocusLost * :if !exists('#goyo') | set number norelativenumber

" Using vim-tmux-navigator bindings, on FocusLost ^[[O was left behind
autocmd FocusLost * silent redraw!
autocmd FocusGained * :if !exists('#goyo') | set number relativenumber

" Toggle relative numbers in insert mode
autocmd InsertEnter * :if !exists('#goyo') | set number norelativenumber
autocmd InsertLeave * :if !exists('#goyo') | set number relativenumber
