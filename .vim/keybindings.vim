" Allow Ctrl-S and Ctrl-Q keybindings to pass through to vim (I do this in .zshrc)
" silent !stty -ixon > /dev/null 2>/dev/null

" Remap jk to Esc in insert mode
" inoremap jk <Esc>

" Quit file
map <c-q> <esc>:q<CR>
imap <c-q> <esc>:q<CR>

" Save file
map <c-s> <esc>:w<CR>
imap <c-s> <esc>:w<CR>

" Start a ruby pry debugger
nmap <leader>bp Orequire 'pry'; binding.pry<esc>^

" Start a javascript debugger
nmap <leader>de Odebugger<esc>^

" Insert a single character w/o going to insert mode using <space><char>
" noremap <silent> <space> :exe "normal i".nr2char(getchar())<CR>

" Search for selected text, forwards or backwards.
" http://vim.wikia.com/wiki/Search_for_visually_selected_text
" vnoremap <silent> * :<C-U>
"       \let old_reg=getreg('"')<Bar>let old_regtype=getregtype('"')<CR>
"       \gvy/<C-R><C-R>=substitute(
"       \escape(@", '/\.*$^~['), '\_s\+', '\\_s\\+', 'g')<CR><CR>
"       \gV:call setreg('"', old_reg, old_regtype)<CR>

" vnoremap <silent> # :<C-U>
"       \let old_reg=getreg('"')<Bar>let old_regtype=getregtype('"')<CR>
"       \gvy?<C-R><C-R>=substitute(
"       \escape(@", '?\.*$^~['), '\_s\+', '\\_s\\+', 'g')<CR><CR>
"       \gV:call setreg('"', old_reg, old_regtype)<CR>

" Movement & wrapped long lines
" nnoremap j gj
" nnoremap k gk

" Converts Ruby 1.8 hashes to 1.9
" command! -bar -range=% NotRocket execute '<line1>,<line2>s/:\(\w\+\)\s*=>/\1:/e' . (&gdefault ? '' : 'g')

" Toggle (switch option) clipboard (pasteboard) syncing on/off
nnoremap cop :set <C-R>=&clipboard =~# "unnamed" ? 'clipboard=' : 'clipboard^=unnamed'<CR><CR>

"" These should probably be remapped to a leader key somehow
" Gets the current version of a gem for a Gemfile
let @v="f\'vi\'yA, \'~> :r !gem sea -r \'^\"$\'|tail -1|cut -f2 -d' '|tr -d '()'kJA\'0j"

" Aligns a trailing comment with the previous line (used in Gemfile)
let @a="kf\';;mm0jf\';;i                                       `mjdt\'0j"

" Open Mac Dictionary to word under cursor
map <leader>d :execute ":silent !open -g dict://"\|redraw!<cr>
