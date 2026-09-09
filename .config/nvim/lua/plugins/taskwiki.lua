return {
  "tools-life/taskwiki",
  dependencies = {
    "vimwiki/vimwiki",
    "preservim/vim-markdown",
    "powerman/vim-plugin-AnsiEsc", -- Optional: for colored charts
  },
  ft = { "vimwiki" },
  init = function()
    -- Pin taskwiki's <LocalLeader> keys to the localleader itself (\a =
    -- annotate, \d = done, \p = projects, ...). Its ftplugin otherwise derives
    -- `g:mapleader .. "t"` and assigns it with an unscoped `let maplocalleader`
    -- — a global that clobbers vim.g.maplocalleader (upstream bug), which
    -- lazy's change detector then reports as "You need to set
    -- vim.g.maplocalleader BEFORE loading lazy" a couple of seconds after a
    -- wiki buffer opens. With the value pinned, the ftplugin's assignment
    -- writes back what was already there and nothing notices.
    vim.g.taskwiki_maplocalleader = vim.g.maplocalleader
  end,
}
