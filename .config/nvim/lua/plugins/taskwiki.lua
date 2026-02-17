return {
  "tools-life/taskwiki",
  dependencies = {
    "vimwiki/vimwiki",
    "preservim/vim-markdown",
    "powerman/vim-plugin-AnsiEsc", -- Optional: for colored charts
  },
  ft = { "vimwiki" },
  init = function()
    -- Taskwiki uses vimwiki, so it will inherit your vimwiki configuration
    -- You can add taskwiki-specific settings here if needed
  end,
}
