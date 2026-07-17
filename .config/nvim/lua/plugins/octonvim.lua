return {
  "pwntester/octo.nvim",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-telescope/telescope.nvim",
    "nvim-tree/nvim-web-devicons",
  },
  cmd = "Octo",
  event = { "VeryLazy", "BufReadCmd octo://*" },
  config = function()
    require("octo").setup({
      default_to_projects_v2 = true,  -- Enable ProjectsV2 support for timeline events
    })
  end,
}
