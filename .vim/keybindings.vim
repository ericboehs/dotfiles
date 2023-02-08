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

" Format JSON
nmap <leader>j :%!ruby -rjson -e 'puts JSON.pretty_generate(JSON.parse(STDIN.read))'<CR>

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
inoremap x<space> <C-R>=col('.') == "1" ? "- [ ] " : getline('.') =~ "- $" ? "[ ] " : "x "<CR>

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

inoremap <M-BS> <C-w>
inoremap <M-Left> <C-Left>
inoremap <M-Right> <C-Right>

" Move lines
nnoremap <D-j> :m .+1<CR>==
nnoremap <D-k> :m .-2<CR>==

" Mimic Emacs Line Editing in Insert Mode Only
inoremap <C-A> <Home>
inoremap <C-B> <Left>
inoremap <C-E> <End>
inoremap <C-F> <Right>

" VimWiki Bindings
nnoremap <Leader>tl <Plug>VimwikiToggleListItem
vnoremap <Leader>tl <Plug>VimwikiToggleListItem

" Next/Previous File
nnoremap ]a :next<cr>
nnoremap [a :prev<cr>

" VimR Tabs
nnoremap <S-D-{> :tabp<CR>
vnoremap <S-D-{> :tabp<CR>
inoremap <S-D-{> :tabp<CR>
nnoremap <S-D-}> :tabn<CR>
vnoremap <S-D-}> :tabn<CR>
inoremap <S-D-}> :tabn<CR>
nnoremap <D-1> 1gt
vnoremap <D-1> 1gt
inoremap <D-1> <Esc>1gt
nnoremap <D-2> 2gt
vnoremap <D-2> 2gt
inoremap <D-2> <Esc>2gt
nnoremap <D-3> 3gt
vnoremap <D-3> 3gt
inoremap <D-3> <Esc>3gt
nnoremap <D-4> 4gt
vnoremap <D-4> 4gt
inoremap <D-4> <Esc>4gt
nnoremap <D-5> 5gt
vnoremap <D-5> 5gt
inoremap <D-5> <Esc>5gt
nnoremap <D-6> 6gt
vnoremap <D-6> 6gt
inoremap <D-6> <Esc>6gt
nnoremap <D-7> 7gt
vnoremap <D-7> 7gt
inoremap <D-7> <Esc>7gt
nnoremap <D-8> 8gt
vnoremap <D-8> 8gt
inoremap <D-8> <Esc>8gt
nnoremap <D-9> 9gt
vnoremap <D-9> 9gt
inoremap <D-9> <Esc>9gt

" Cmd-Left/Right to go to beginning/end of line
inoremap <D-Left> <Home>
inoremap <D-Right> <End>

" Converts visual selection to array (e.g. a\nb\nc -> ["a", "b", "c"])
vnoremap <Leader>a !ruby -e 'p $stdin.read.split'<cr>

" Search for visual selection
xnoremap * :<C-u>call <SID>VSetSearch()<CR>/<C-R>=@/<CR><CR>
xnoremap # :<C-u>call <SID>VSetSearch()<CR>?<C-R>=@/<CR><CR>

function! s:VSetSearch()
    let temp = @s
    norm! gv"sy
    let @/ = '\V' . substitute(escape(@s, '/\'), '\n', '\\n','g')
    let @s = temp
endfunction

" Converts Ruby 1.8 hashes to 1.9
" command! -bar -range=% NotRocket execute '<line1>,<line2>s/:\(\w\+\)\s*=>/\1:/e' . (&gdefault ? '' : 'g')

"" These should probably be remapped to a leader key somehow
" Gets the current version of a gem for a Gemfile
" let @v="f\'vi\'yA, \'~> :r !gem sea -r \'^\"$\'|tail -1|cut -f2 -d' '|tr -d '()'kJA\'0j"

" Aligns a trailing comment with the previous line (used in Gemfile)
" let @a="kf\';;mm0jf\';;i                                       `mjdt\'0j"
