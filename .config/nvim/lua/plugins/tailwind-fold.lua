return {
  {
    "nvim-treesitter/nvim-treesitter",
    opts = function(_, opts)
      vim.list_extend(opts.ensure_installed or {}, {
        "html",
        "ruby",
        "embedded_template",
      })

      vim.filetype.add({
        extension = {
          erb = "eruby",
          ["html.erb"] = "eruby",
        },
      })
    end,
  },

  {
    "razak17/tailwind-fold.nvim",
    dependencies = { "nvim-treesitter/nvim-treesitter" },
    ft = {
      "html", "svelte", "astro", "vue", "tsx", "typescriptreact",
      "php", "blade", "eruby", "erb", "edge", "htmldjango",
    },
    opts = {},
  },
}
