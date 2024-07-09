-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Ctrl-q to Quit
vim.keymap.set("n", "<C-q>", ":q<CR>")
vim.keymap.set("i", "<C-q>", "<Esc>:q<CR>")

-- Tmux Navigator
vim.keymap.set("n", "<C-h>", "<Cmd>NvimTmuxNavigateLeft<CR>", { silent = true })
vim.keymap.set("n", "<C-j>", "<Cmd>NvimTmuxNavigateDown<CR>", { silent = true })
vim.keymap.set("n", "<C-k>", "<Cmd>NvimTmuxNavigateUp<CR>", { silent = true })
vim.keymap.set("n", "<C-l>", "<Cmd>NvimTmuxNavigateRight<CR>", { silent = true })

-- Vim Tmux Runner
vim.keymap.set("n", "<leader>ta", "<Cmd>VtrAttachToPane<CR>", { silent = true })
vim.keymap.set("n", "<leader>tc", "<Cmd>VtrSendCommandToRunner<CR>", { silent = true })
vim.keymap.set("n", "<leader>tl", "<Cmd>VtrSendLinesToRunner<CR>", { silent = true })
vim.keymap.set("v", "<leader>tl", "<Cmd>VtrSendLinesToRunner<CR>", { silent = true })

-- Disable moving lines via <M-j> and <M-k>
vim.keymap.set("n", "<M-j>", "j")
vim.keymap.set("n", "<M-k>", "k")
