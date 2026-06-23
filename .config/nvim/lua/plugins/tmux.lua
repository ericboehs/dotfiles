return {
  {
    "alexghergh/nvim-tmux-navigation",
    event = "VeryLazy",
    config = function()
      require("nvim-tmux-navigation").setup({})
    end,
  },
  {
    "christoomey/vim-tmux-runner",
    cmd = { "VtrSendCommandToRunner", "VtrOpenRunner", "VtrFlushCommand", "VtrClearRunner" },
  },
}
