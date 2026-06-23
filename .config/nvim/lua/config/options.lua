-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Sync system clipboard with vim clipboard
vim.opt.clipboard = "unnamedplus"

-- Disable auto formatting for all file types
vim.g.autoformat = false

-- Hide statusline
vim.opt.laststatus = 0

-- Disable unused providers (~300ms startup savings)
vim.g.loaded_ruby_provider = 0
vim.g.loaded_perl_provider = 0
vim.g.loaded_python3_provider = 0
vim.g.loaded_node_provider = 0
