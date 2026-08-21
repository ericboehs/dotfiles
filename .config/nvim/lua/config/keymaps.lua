-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Ctrl-q to Quit
vim.keymap.set("n", "<C-q>", ":q<CR>")
vim.keymap.set("i", "<C-q>", "<Esc>:q<CR>")

-- Tmux Navigator: try an nvim split first, and hand off to pane-nav.sh when
-- there is none that way. That is the same script Ctrl-h/j/k/l run from
-- tmux.conf, so a split edge, a pane edge, a window edge and a session edge all
-- behave identically. nvim-tmux-navigation could not do this: it shells out to
-- `tmux select-pane` directly, which stops dead at the edge of the window and
-- never reaches the tmux key binding.
local function navigate(direction)
  return function()
    local from = vim.api.nvim_get_current_win()
    pcall(vim.cmd.wincmd, direction)
    if vim.api.nvim_get_current_win() == from and vim.env.TMUX then
      vim.system({ vim.fn.expand("~/.tmux/pane-nav.sh"), direction })
    end
  end
end

for _, direction in ipairs({ "h", "j", "k", "l" }) do
  vim.keymap.set("n", "<C-" .. direction .. ">", navigate(direction), { silent = true })
end

-- Vim Tmux Runner
vim.keymap.set("n", "<leader>ta", "<Cmd>VtrAttachToPane<CR>", { silent = true })
vim.keymap.set("n", "<leader>tc", "<Cmd>VtrSendCommandToRunner<CR>", { silent = true })
vim.keymap.set("n", "<leader>tl", "<Cmd>VtrSendLinesToRunner<CR>", { silent = true })
vim.keymap.set("v", "<leader>tl", "<Cmd>VtrSendLinesToRunner<CR>", { silent = true })
vim.keymap.set("v", "<leader>tq", "<Cmd>VtrSendCommandToRunner q<CR>", { silent = true })

-- Disable moving lines via <M-j> and <M-k>
vim.keymap.set("n", "<M-j>", "j")
vim.keymap.set("n", "<M-k>", "k")

-- Octo.nvim --
vim.keymap.set("n", "<leader>gV", "<Cmd>Octo issue create department-of-veterans-affairs/va.gov-team<CR>")

-- Repeat in visual mode
vim.keymap.set('x', '.', ':normal .<CR>')
