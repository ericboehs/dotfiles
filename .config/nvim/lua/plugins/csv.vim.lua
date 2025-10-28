return {
  'chrisbra/csv.vim',
  ft = { 'csv', 'dat' },
  config = function()
    -- Ensure filetype plugins are enabled
    vim.cmd('filetype plugin on')

    -- Set CSV plugin options
    vim.g.csv_autocmd_arrange = 1
    vim.g.csv_autocmd_arrange_size = 1024*1024

    vim.g.csv_bind_B = 1
  end,
}
