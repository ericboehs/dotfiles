" Yank and put system pasteboard with <Leader>y/p.
" noremap <Leader>y "*y
" noremap <Leader>Y "*y$
" Yank to ~/bin/rpbcopy. See: http://seancoates.com/blogs/remote-pbcopy
noremap <Leader>y "0y:call system('~/bin/rpbcopy', @0)<cr><cr>
noremap <Leader>Y ":call system('~/bin/rpbcopy', @0)<cr><cr>
nnoremap <Leader>yy "*yy
noremap <Leader>p "*p
noremap <Leader>P "*P

" Copy relative path to the system pasteboard
nnoremap <silent><Leader>cf :let @*=expand('%')<CR>

" Copy relative path and line number to the system pasteboard
nnoremap <silent><Leader>cl :let @*=expand('%').':'.line('.')<CR>

" paste mode toggle (needed when using autoindent/smartindent)
map <F10> :set paste<CR>
map <F11> :set nopaste<CR>
imap <F10> <C-O>:set paste<CR>
imap <F11> <nop>
set pastetoggle=<F11>

" PasteAsCoffee
map <Leader>pc :PasteAsCoffee<CR>

" Add Function key mappings for Mac
if has('mac') && ($TERM == 'xterm-256color' || $TERM == 'screen-256color')
  map <Esc>OP <F1>
  map <Esc>OQ <F2>
  map <Esc>OR <F3>
  map <Esc>OS <F4>
  map <Esc>[16~ <F5>
  map <Esc>[17~ <F6>
  map <Esc>[18~ <F7>
  map <Esc>[19~ <F8>
  map <Esc>[20~ <F9>
  map <Esc>[21~ <F10>
  map <Esc>[23~ <F11>
  map <Esc>[24~ <F12>
endif

" Add Option-N mappings for tab switching (in iTerm use left option as +Esc)
map <Esc>] gt
map <Esc>[ gT
map <Esc>1 1gt
map <Esc>2 2gt
map <Esc>3 3gt
map <Esc>4 4gt
map <Esc>5 5gt
map <Esc>6 6gt
map <Esc>7 7gt
map <Esc>8 8gt
map <Esc>9 9gt

" Remap hhh to Esc in insert mode
inoremap hhh <Esc>
" Remap jj to Esc in insert mode
inoremap jj <Esc>
" Remap jk to Esc in insert mode
inoremap jk <Esc>
" Remap kkk to Esc in insert mode
inoremap kkk <Esc>
" Remap lll to Esc in insert mode
inoremap lll <Esc>

" Quick access to source .vimrc
nmap <leader>ss :source $HOME/.vimrc<CR>

" Quick open of localhost
nmap <silent> <leader>oo :!open http://
nmap <silent> <leader>ol :!open http://localhost:3000<CR><CR>

" Quit file
map <C-q> <esc>:q<CR>
imap <C-q> <esc>:q<CR>

map <C-q><C-q> <esc>:q!<CR>
imap <C-q><C-q> <esc>:q!<CR>

" Save file
map <C-s> <esc>:w<CR>
imap <C-s> <esc>:w<CR>

" Force save file
map <C-s><C-s> <esc>:w!<CR>
imap <C-s><C-s> <esc>:w!<CR>

" Sudo save file
map <C-s><C-s><C-s> <esc>:w!!<CR>
imap <C-s><C-s><C-s> <esc>:w!!<CR>

" Sudo save file
cmap w!! execute 'silent w !sudo tee > /dev/null %' \| edit!

" Windoj Navigation
" Use ctrl+(j|k) to move through open windows.
map <C-j> <C-w>j
map <C-k> <C-w>k

" Clear search
noremap <silent> <c-l> :nohls<cr><c-l>

" NERDTree
map <leader>n :NERDTreeToggle<CR>
map <leader>N :NERDTreeFind<CR>

" Search
map <Leader>r :%s///g<left><left>

" Ag with <leader>f
map <Leader>f :Ag!<Space>

" Highlight word at cursor without changing position
nnoremap <leader>h *<C-O>
" Highlight word at cursor and then Ag it.
nnoremap <leader>H *<C-O>:AgFromSearch!<CR>

map <Leader>F :AgFromSearch<CR>

" Use \d (or \dd or \dj or 20\dd) to delete a line without yanking
nmap <silent> <leader>d "_d
vmap <silent> <leader>d "_d

" Disable cursor keys
inoremap <Up> <Nop>
inoremap <Down> <Nop>
inoremap <Left> <Nop>
inoremap <Right> <Nop>
inoremap <M-Up> <Nop>
inoremap <M-Down> <Nop>
inoremap <M-Left> <Nop>
inoremap <M-Right> <Nop>
noremap <Up> <Esc>
noremap <Down> <Esc>
noremap <Left> <Esc>
noremap <Right> <Esc>
vmap <Up> <Esc><Esc>gv
vmap <Down> <Esc><Esc>gv
vmap <Left> <Esc><Esc>gv
vmap <Right> <Esc><Esc>gv

" Yank from the cursor to the end of the line, to be consistent with C and D
nnoremap Y y$

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

" select all
map <Leader>a ggVG

" Toggle spell checking
map <Leader>S :set spell!<CR>

" Movement & wrapped long lines
" This solves the problem that pressing down jumps your cursor 'over' the
" current line to the next line
nnoremap j gj
nnoremap k gk

" Converts Ruby 1.8 hashes to 1.9
command! -bar -range=% NotRocket execute '<line1>,<line2>s/:\(\w\+\)\s*=>/\1:/e' . (&gdefault ? '' : 'g')

" Gundo
nnoremap <F5> :GundoToggle<CR>

" Tagbar
nnoremap <F8> :TagbarToggle<CR>
