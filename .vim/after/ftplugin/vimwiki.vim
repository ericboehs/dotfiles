let ayucolor="light"                 " ayu requires this to force light mode
silent! colorscheme ayu              " Use ayu to differentiate Terminal vim from MacVim
set nowrap
set laststatus=0                     " No status bar
set noshowmode                       " Don't show the mode at the bottom
set noshowcmd                        " Don't show the current command at the bottom
set noruler                          " Hide the ruler from last line (0,0-1)
set guifont=Menlo-Regular:h16        " Use a larger font
set norelativenumber                 " No relative line numbers
set nonumber                         " No line numbers
:set title titlestring=%<%f          " Set the title to just be the current file name (no path)
let &fcs='eob: '                     " No gutter ~ for empty lines
autocmd BufEnter * silent! lcd %:p:h " Auto lcd to file's directory
let g:netrw_sort_by= "time"          " Sort netrw (:Ex) by modified time
let g:netrw_sort_direction="reverse" " Reverse netrw sort direction (latest on top)
