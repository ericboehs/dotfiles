return {
  {
    "jghauser/follow-md-links.nvim",
    ft = { "markdown" },
  },
  {
    "MeanderingProgrammer/render-markdown.nvim",
    -- vimwiki sets `filetype=vimwiki` on every *.md under ~/Documents/Wiki, so the
    -- upstream `ft` list (markdown, norg, rmd, org, codecompanion) never matches
    -- there. lazy.nvim concatenates `ft` across specs, so this only adds to it.
    ft = { "vimwiki" },
    init = function()
      -- Point the markdown treesitter parser at vimwiki buffers; without this
      -- render-markdown has no tree to walk and silently renders nothing.
      vim.treesitter.language.register("markdown", "vimwiki")
    end,
    opts = {
      file_types = { "markdown", "vimwiki" },
      heading = {
        sign = false,
        icons = { "󰲡 ", "󰲣 ", "󰲥 ", "󰲧 ", "󰲩 ", "󰲫 " },
      },
      checkbox = {
        enabled = true,
      },
    },
  },
}
