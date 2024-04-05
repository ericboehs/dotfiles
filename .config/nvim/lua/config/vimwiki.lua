vim.g.vimwiki_list = {
  {
    path = '~/Documents/Wiki',
    path_html = '~/Documents/Wiki/html',
    syntax = 'markdown',
    diary_rel_path = './daily',
    auto_diary_index = 1,
    ext = '.md',
  },
}

vim.g.vimwiki_global_ext = 0 -- Don't create temporary wikis (they must be in the wiki_list)
vim.g.vimwiki_auto_header = 1 -- Put the file name as a first level header when creating a new entry
vim.g.calendar_diary = '~/Documents/Wiki/daily/'
