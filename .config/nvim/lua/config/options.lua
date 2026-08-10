-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Sync system clipboard with vim clipboard
vim.opt.clipboard = "unnamedplus"

-- Disable auto formatting for all file types
vim.g.autoformat = false

-- Hide statusline
vim.opt.laststatus = 0

-- Disable unused language providers for faster startup.
-- python3 stays enabled: taskwiki/vimwiki require it (`has('python3')`).
-- Pin the mise-resolved python3 so nvim skips host autodetection.
local py3 = vim.fn.exepath("python3")
if py3 ~= "" then
  vim.g.python3_host_prog = py3
end
vim.g.loaded_ruby_provider = 0
vim.g.loaded_perl_provider = 0
vim.g.loaded_node_provider = 0
