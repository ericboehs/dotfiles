let g:vimwiki_list = [
      \{
      \ 'path': '~/Documents/Wiki',
      \ 'path_html': '~/Documents/Wiki/html',
      \ 'diary_rel_path': './',
      \ 'auto_diary_index': 1,
      \ 'syntax': 'markdown',
      \ 'ext': '.md' },
      \]

let g:vimwiki_global_ext = 0     " Don't create temporary wikis (they must be in the wiki_list)
let g:vimwiki_auto_header = 1    " Put the file name as a first level header when creating a new entry

let g:calendar_diary = '~/Documents/Wiki'

autocmd VimEnter * let g:vimwiki_syntaxlocal_vars['markdown']['Link1'] = g:vimwiki_syntaxlocal_vars['default']['Link1']

autocmd FocusLost,FocusLost * if &ft==# 'vimwiki' | :update | endif

" Auto open VimWiki in MacVim
if has("gui_vimr")
  " Had to add a delay or VimWiki wasn't fully loaded
  autocmd VimEnter * call timer_start(0, { tid -> execute('VimwikiMakeDiaryNote')})
endif
