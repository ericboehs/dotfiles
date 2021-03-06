" Allow Ctrl-S and Ctrl-Q keybindings to pass through to vim (I do this in .zshrc)
" silent !stty -ixon > /dev/null 2>/dev/null

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

" Run current line as SQL against local db (via dadbod)
nmap <leader>db :.DB<CR>

" Auto-commit Wiki
nmap <leader>wc :!cd ~/Documents/Wiki && git add . && git commit -m 'Auto-commit' && git push<CR>

" Goyo
nmap <leader>g :Goyo<CR>

" Insert markdown header with filename
nmap <leader>fn i# <C-R>=expand("%:t:r")<CR><CR><CR>

" Insert current date with day name (e.g. 2020-11-02 Monday)
nnoremap <F5> "=strftime("%Y-%m-%d %A")<CR>P
inoremap <F5> <C-R>=strftime("%Y-%m-%d %A")<CR>

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
xnoremap <leader>c "+y
nnoremap <leader>c "+yy
xnoremap <leader>p "+p
nnoremap <leader>p "+p

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

nnoremap <Esc><Left> :-tabmove<CR>
nnoremap <Esc><Right> :+tabmove<CR>
inoremap <M-BS> <C-w>
inoremap <M-Left> <C-Left>
inoremap <M-Right> <C-Right>

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
nnoremap j gj
nnoremap k gk

" Mimic Emacs Line Editing in Insert Mode Only
inoremap <C-A> <Home>
inoremap <C-B> <Left>
inoremap <C-E> <End>
inoremap <C-F> <Right>

" Converts Ruby 1.8 hashes to 1.9
" command! -bar -range=% NotRocket execute '<line1>,<line2>s/:\(\w\+\)\s*=>/\1:/e' . (&gdefault ? '' : 'g')

" Toggle (switch option) clipboard (pasteboard) syncing on/off
nnoremap cop :set <C-R>=&clipboard =~# "unnamed" ? 'clipboard=' : 'clipboard^=unnamed'<CR><CR>

"" These should probably be remapped to a leader key somehow
" Gets the current version of a gem for a Gemfile
let @v="f\'vi\'yA, \'~> :r !gem sea -r \'^\"$\'|tail -1|cut -f2 -d' '|tr -d '()'kJA\'0j"

" Aligns a trailing comment with the previous line (used in Gemfile)
let @a="kf\';;mm0jf\';;i                                       `mjdt\'0j"

" CleverTab (taken from :help ins-completion)
function! CleverTab()
  if strpart( getline('.'), 0, col('.')-1 ) =~ '^\s*$'
    return "\<Tab>"
  else
    return "\<C-N>"
  endif
endfunction
" inoremap <Tab> <C-R>=CleverTab()<CR>
" I'm not enabling this yet. I want to see how I do with C-n/C-p

function! CleverShiftTab()
  if strpart( getline('.'), 0, col('.')-1 ) =~ '^\s*$'
    return "\<C-d>"
  else
    return "\<C-P>"
  endif
endfunction
" inoremap <S-Tab> <C-R>=CleverShiftTab()<CR>
