-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
-- Add any additional autocmds here

-- Markdown: soft-wrap with hanging indent so wrapped list/checkbox lines
-- align under the text rather than the bullet. Scoped per-filetype so code
-- files keep the global wrap=false.
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown", "markdown.mdx", "vimwiki" },
  callback = function()
    vim.opt_local.wrap = true
    vim.opt_local.spell = false -- LazyVim enables spell for markdown; turn off the red squiggles
    vim.opt_local.linebreak = true -- break at word boundaries, not mid-word
    vim.opt_local.breakindent = true
    vim.opt_local.breakindentopt = "list:-1" -- indent wraps by the list marker width
    -- Match -, *, +, numbered (1. / 1)) and markdown checkboxes (- [ ] / - [x])
    vim.opt_local.formatlistpat = [[^\s*\%(\d\+[.)]\|[-*+]\)\s\+\%(\[[ xX]\]\s\+\)\?]]
  end,
})

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
