let g:vimwiki_list = [
      \{
      \ 'path': '~/Documents/Wiki',
      \ 'path_html': '~/Documents/Wiki/html',
      \ 'diary_rel_path': './',
      \ 'syntax': 'markdown',
      \ 'ext': '.md' },
      \]
let g:vimwiki_global_ext = 0
let g:vimwiki_auto_header = 1
autocmd VimEnter * let g:vimwiki_syntaxlocal_vars['markdown']['Link1'] = g:vimwiki_syntaxlocal_vars['default']['Link1']

autocmd FocusLost,FocusLost * if &ft==# 'vimwiki' | :update | endif
