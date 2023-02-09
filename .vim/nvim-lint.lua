-- The following command requires plug-ins "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim", and optionally "kyazdani42/nvim-web-devicons" for icon support
vim.api.nvim_set_keymap('n', '<leader>dd', '<cmd>lua vim.diagnostic.setqflist()<CR>', { noremap = true, silent = true })
vim.api.nvim_set_keymap('n', '<leader>dt', '<cmd>Telescope diagnostics<CR>', { noremap = true, silent = true })

require('lint').linters_by_ft = {
  gitcommit = {'codespell','vale',},
  markdown = {'markdownlint','vale',},
  rb = {'rubocop',},
  ruby = {'rubocop',},
  sh = {'shellcheck',},
  zsh = {'shellcheck',},
  css = {'stylelint',},
  scss = {'stylelint',},
  html = {'tidy',},
  javascript = {'eslint',},
  javascriptreact = {'eslint',},
  typescript = {'eslint',},
  typescriptreact = {'eslint',},
  vue = {'eslint',},
  json = {'jsonlint',},
  yaml = {'yamllint',},
  python = {'flake8',},
  go = {'golangci-lint',},
  lua = {'luacheck',},
}

vim.api.nvim_create_autocmd({ "BufWritePost" }, {
  callback = function()
    require("lint").try_lint()
  end,
})
