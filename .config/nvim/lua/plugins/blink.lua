return {
  -- Disable blink.cmp's auto-popup; trigger completion manually with <C-Space>
  {
    "saghen/blink.cmp",
    opts = {
      completion = {
        menu = {
          auto_show = false,
        },
        -- Don't show the inline preview/ghost text of the current suggestion
        ghost_text = {
          enabled = false,
        },
      },
    },
  },
}
