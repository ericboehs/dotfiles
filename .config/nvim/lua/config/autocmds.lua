-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
-- Add any additional autocmds here

-- Vimwiki: Handle custom URL schemes like octo://
vim.api.nvim_create_autocmd("FileType", {
  pattern = "vimwiki",
  callback = function()
    vim.cmd([[
      function! VimwikiLinkHandler(link)
        " Check if the link starts with octo://
        if a:link =~# '^octo://'
          " Normalize GitHub URL format: convert /issues/ to /issue/ and /pulls/ to /pull/
          let normalized_link = substitute(a:link, '/issues/', '/issue/', '')
          let normalized_link = substitute(normalized_link, '/pulls/', '/pull/', '')
          " Open the octo:// URL as a buffer
          execute 'edit ' . normalized_link
          return 1
        endif
        " Let Vimwiki handle other links normally
        return 0
      endfunction
    ]])
  end,
})
