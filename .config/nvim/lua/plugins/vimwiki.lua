return {
  -- The plugin location on GitHub
  "vimwiki/vimwiki",
  -- Load when a markdown file is read or created. Deliberately not BufEnter:
  -- lazy replays only the event that triggered the load, and vimwiki sets
  -- `filetype=vimwiki` from its BufNewFile,BufRead autocmd — under BufEnter
  -- the ftplugin never ran, so the first .md opened in a session kept plain
  -- markdown filetype and vimwiki's C-Up/C-Down diary navigation did nothing.
  event = { "BufNewFile *.md", "BufReadPost *.md" },
  -- The keys that trigger the plugin
  keys = { "<leader>ww", "<leader>w<leader>w", "<leader>wt" },
  -- The configuration for the plugin
  init = function()
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
  end,
}
