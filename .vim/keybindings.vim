" Allow Ctrl-S and Ctrl-Q keybindings to pass through to vim
" silent !stty -ixon > /dev/null 2>/dev/null

" Remap jk to Esc in insert mode
inoremap jk <Esc>

" Ctrl-P to fuzzy search files with FZF
" map <c-p> :FZF<CR>
nnoremap <c-p> :FilesMru --tiebreak=end<CR>
map <c-t> :Tags<CR>
map <Leader>g :call fzf#run({'source': 'echo "$(git diff --name-only --cached)\n$(git diff --name-only)\n$(git diff --name-only master..)" \| awk NF', 'sink': 'e', 'options': '--multi', 'down': '40%'})<CR>
nnoremap <Esc>p :Buffers<CR>

" Quit file
map <c-q> <esc>:q<CR>
imap <c-q> <esc>:q<CR>

" Save file
map <c-s> <esc>:w<CR>
imap <c-s> <esc>:w<CR>

" Ack with <leader>f
map <Leader>f :Ack!<Space>

" Highlight word at cursor and then Ack it.
nnoremap <leader>H *<C-O>:AckFromSearch!<CR>

" List related tags in quickfix window
nmap <c-]> :ltag <C-R><C-W><CR>:lopen<CR><CR>

" Quickly search project for search
map <leader>F :AckFromSearch!<CR>

" Start a ruby pry debugger
:nmap <leader>bp Orequire 'pry'; binding.pry<esc>^
:nmap <leader>br Orequire 'pry'; binding.remote_pry<esc>^

" Start a javascript debugger
:nmap <leader>de Odebugger<esc>^

" Insert a single character w/o going to insert mode using <space><char>
noremap <silent> <space> :exe "normal i".nr2char(getchar())<CR>

" Search for selected text, forwards or backwards.
" http://vim.wikia.com/wiki/Search_for_visually_selected_text
vnoremap <silent> * :<C-U>
  \let old_reg=getreg('"')<Bar>let old_regtype=getregtype('"')<CR>
  \gvy/<C-R><C-R>=substitute(
  \escape(@", '/\.*$^~['), '\_s\+', '\\_s\\+', 'g')<CR><CR>
  \gV:call setreg('"', old_reg, old_regtype)<CR>

vnoremap <silent> # :<C-U>
  \let old_reg=getreg('"')<Bar>let old_regtype=getregtype('"')<CR>
  \gvy?<C-R><C-R>=substitute(
  \escape(@", '?\.*$^~['), '\_s\+', '\\_s\\+', 'g')<CR><CR>
  \gV:call setreg('"', old_reg, old_regtype)<CR>

" Movement & wrapped long lines
nnoremap j gj
nnoremap k gk

" Converts Ruby 1.8 hashes to 1.9
command! -bar -range=% NotRocket execute '<line1>,<line2>s/:\(\w\+\)\s*=>/\1:/e' . (&gdefault ? '' : 'g')

" UndoTree
nnoremap <F5> :UndotreeToggle<CR>

" Tagbar
nnoremap <F8> :TagbarToggle<CR>

" Toggle (change option) clipboard (pasteboard) syncing on/off
nnoremap cop :set <C-R>=&clipboard =~# "unnamed" ? 'clipboard=' : 'clipboard=unnamed'<CR><CR>

" Copy/Paste from system clipboard with Alt-C/Alt-V
vnoremap <Esc>c "*y
nnoremap <Esc>v "*p
