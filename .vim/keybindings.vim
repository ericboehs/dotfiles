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

" Open markdown URL (works with app protocols like slack://)
nmap <leader><space> f(yi):silent !open "<c-r>"" &<cr>

" Open GitHub user/repo
vmap <leader><space> y:silent !open "https://github.com/<c-r>"" &<cr>

" Reveal current file in finder
nmap <leader>F :execute "silent !open -R " . shellescape("%")<CR>

" Insert current date with day name (e.g. 2020-11-02 Monday)
nnoremap <F5> "=strftime("%Y-%m-%d %A")<CR>P
inoremap <F5> <C-R>=strftime("%Y-%m-%d %A")<CR>

" Insert current date with day name (e.g. 2020-11-02 Monday)
nnoremap <F6> "=strftime("%-l:%M %p")<CR>P
inoremap <F6> <C-R>=strftime("%-l:%M %p")<CR>

" Insert "- [ ] " when typing "x " at the beginning of a line or if the line ends with "- "
inoremap x<space> <C-R>=col('.') == "1" ? "- [ ]" : getline('.') =~ "- $" ? "[ ] " : "x "<CR>

" Create a Markdown-link structure for the current word or visual selection with
" leader 3. Paste in the URL later. Or use leader 4 to insert the current
" system clipboard as an URL.
nnoremap <leader>3 ciw[<C-r>"]()<Esc>
vnoremap <leader>3 c[<C-r>"]()<Esc>
nnoremap <leader>4 ciw[<C-r>"](<C-r>*)<Esc>
vnoremap <leader>4 c[<C-r>"](<C-r>*)<Esc>

" Open current file in Marked 2
nmap <leader>m :silent !open -ga "Marked 2" "%"<CR>

" Copy/paste from system clipboard
xnoremap <M-c> "+y
nnoremap <M-c> "+yy
xnoremap <M-p> "+p
nnoremap <M-p> "+p

" Press `Esc`, `1` to go to tab 1 (etc)
nnoremap <silent> <Esc>1 :tabn 1<CR>
nnoremap <silent> <Esc>2 :tabn 2<CR>
nnoremap <silent> <Esc>3 :tabn 3<CR>
nnoremap <silent> <Esc>4 :tabn 4<CR>
nnoremap <silent> <Esc>5 :tabn 5<CR>
nnoremap <silent> <Esc>6 :tabn 6<CR>
nnoremap <silent> <Esc>7 :tabn 7<CR>
nnoremap <silent> <Esc>8 :tabn 8<CR>
nnoremap <silent> <Esc>9 :tabn 9<CR>

nnoremap <silent> <Esc><Left> :-tabmove<CR>
nnoremap <silent> <Esc><Right> :+tabmove<CR>
nnoremap <silent> <M-h> :tabprev<CR>
nnoremap <silent> <M-l> :tabnext<CR>

inoremap <M-BS> <C-w>
inoremap <M-Left> <C-Left>
inoremap <M-Right> <C-Right>

" Mimic Emacs Line Editing in Insert Mode Only
inoremap <C-A> <Home>
inoremap <C-B> <Left>
inoremap <C-E> <End>
inoremap <C-F> <Right>

" Converts Ruby 1.8 hashes to 1.9
" command! -bar -range=% NotRocket execute '<line1>,<line2>s/:\(\w\+\)\s*=>/\1:/e' . (&gdefault ? '' : 'g')

"" These should probably be remapped to a leader key somehow
" Gets the current version of a gem for a Gemfile
" let @v="f\'vi\'yA, \'~> :r !gem sea -r \'^\"$\'|tail -1|cut -f2 -d' '|tr -d '()'kJA\'0j"

" Aligns a trailing comment with the previous line (used in Gemfile)
" let @a="kf\';;mm0jf\';;i                                       `mjdt\'0j"
