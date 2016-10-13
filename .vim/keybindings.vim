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

" Ag with <leader>f
map <Leader>f :Ag!<Space>

" Highlight word at cursor and then Ag it.
nnoremap <leader>H *<C-O>:AgFromSearch!<CR>

" List related tags in quickfix window
nmap <c-]> :ltag <C-R><C-W><CR>:lopen<CR><CR>

" Quickly search project for search
map <leader>F :AgFromSearch!<CR>

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

"" Perl to Ruby Refactoring
command! -bar -range=% PTRRemoveSemis execute '<line1>,<line2>s/;\n/\r/e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRReplaceEq execute '<line1>,<line2>s/ eq / == /e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRReplaceIf execute '<line1>,<line2>s/\vif\((.*)\)( |\n)(\s+)?\{/if \1/e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRReplaceForEach execute '<line1>,<line2>s/\vforeach my \$(\w+) \(\@(\w+)\)(\n\s+\{)?/\2.each do |\1|/e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRReplaceMap normal f{%elyeF}%BPa.<Esc>ea do |changeme|<Esc>^hy0f{%Cend<Esc>^hv0"0p<C-o>xxV/end<CR>:s/\$_/changeme/g<CR>:noh<CR>
command! -bar -range=% PTRReplaceArrow execute '<line1>,<line2>s/->/./e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRMakeLocalVariables execute '<line1>,<line2>s/\v(my )?[$@](\w+)/\2/e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRRemoveOpenBraces execute '<line1>,<line2>s/\v^\s+\{\n//e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRReplaceCloseBrace execute '<line1>,<line2>s/\v^(\s+)}\n/\1end\r/e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRRemoveSelf execute '<line1>,<line2>s/\v\$self(\.)?//e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRRemoveMy execute '<line1>,<line2>s/my \$//e' . (&gdefault ? '' : 'g')
command! -bar -range=% PTRRemoveValue execute '<line1>,<line2>s/\v(-\>|\.)value//e' . (&gdefault ? '' : 'g')

" Overrite ruby refactoring method extraction
command! -bar -range=% RExtractMethod normal <Esc>`<widef <Esc>wwxxhr<CR>`<gv=`>oend<CR><Esc>gv2j
