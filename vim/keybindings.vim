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

" Remap hhh to Esc in insert mode
inoremap hhh <Esc>
" Remap jj to Esc in insert mode
inoremap jj <Esc>
" Remap kkk to Esc in insert mode
inoremap kkk <Esc>
" Remap lll to Esc in insert mode
inoremap lll <Esc>

" Quick access to source .vimrc
nmap <leader>ss :source $HOME/.vimrc<CR>

" Quick open of localhost
nmap <silent> <leader>oo :!open http://
nmap <silent> <leader>ol :!open http://localhost:3000<CR><CR>

" Kill zeus and restart
nmap <silent> <leader>kzz :!tmux kill-window -t 5 && tmux new-window -n zeus "zeus start" && tmux set-window-option -t $SESSION:5 monitor-activity off && tmux send-keys -t 4.1 C-c; sleep 0.5; tmux send-keys -t 4.1 C-l; sleep 0.5; tmux send-keys -t 4.1 zeus\ s C-m && tmux new-window -n zeus "zeus start" && tmux select-window -t 2<CR><CR>
nmap <silent> <leader>kzt :!tmux kill-window -t 5 && tmux new-window -n zeus "zeus start" && tmux set-window-option -t $SESSION:5 monitor-activity off && tmux select-window -t 2<CR><CR>
nmap <silent> <leader>kzc :!tmux send-keys -t 4.0 C-c; sleep 0.5; tmux send-keys -t 4.0 C-d; sleep 0.5; tmux send-keys -t 4.0 C-l; sleep 0.5; tmux send-keys -t 4.0 zeus\ c C-m && tmux select-window -t 2<CR><CR>
nmap <silent> <leader>kzs :!tmux send-keys -t 4.1 C-c; sleep 0.5; tmux send-keys -t 4.1 C-l; sleep 0.5; tmux send-keys -t 4.1 zeus\ s C-m && tmux select-window -t 2<CR><CR>

" Save file
map <C-s> <esc>:w<CR>
imap <C-s> <esc>:w<CR>

" Sudo save file
cmap w!! w !sudo tee > /dev/null %

" Window Navigation
" Use ctrl+(h|j|k|j) to move through open windows.
map <C-h> <C-w>h
map <C-j> <C-w>j
map <C-k> <C-w>k
map <C-l> <C-w>l

" Clear search
noremap <silent> <c-l> :nohls<cr><c-l>

" NERDTree
map <leader>n :NERDTreeToggle<CR>
map <leader>N :NERDTreeFind<CR>

" Ack with <leader>f
map <Leader>f :Ack!<Space>

" Highlight word at cursor without changing position
nnoremap <leader>h *<C-O>
" Highlight word at cursor and then Ack it.
nnoremap <leader>H *<C-O>:AckFromSearch!<CR>

map <Leader>F :AckFromSearch<CR>

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

" paste mode toggle (needed when using autoindent/smartindent)
map <F10> :set paste<CR>
map <F11> :set nopaste<CR>
imap <F10> <C-O>:set paste<CR>
imap <F11> <nop>
set pastetoggle=<F11>

" PasteAsCoffee
map <Leader>pc :PasteAsCoffee<CR>

" Gundo
nnoremap <F5> :GundoToggle<CR>

" Tagbar
nnoremap <F8> :TagbarToggle<CR>

" Run current buffer/line and output contents into file
nmap <buffer> <Leader>r <Plug>(xmpfilter-run)
xmap <buffer> <Leader>r <Plug>(xmpfilter-run)
imap <buffer> <Leader>r <Plug>(xmpfilter-run)

nmap <buffer> <Leader>R <Plug>(xmpfilter-mark)
xmap <buffer> <Leader>R <Plug>(xmpfilter-mark)
imap <buffer> <Leader>R <Plug>(xmpfilter-mark)
