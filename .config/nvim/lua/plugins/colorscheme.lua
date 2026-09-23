return {
  {
    "catppuccin/nvim",
    name = "catppuccin",
    opts = function(_, opts)
      local U = require("catppuccin.utils.colors")
      -- Catppuccin paints markdown in red/pink by default: @markup.strong and
      -- @markup.italic are C.red, @markup.quote is C.pink, and headings use the
      -- rainbow ramp whose first stop is C.red. In a notes buffer that's mostly
      -- bold text and blockquotes, that's a wall of red. Cool ramp instead, and
      -- let bold/italic carry their own weight rather than a color.
      opts.custom_highlights = function(colors)
        local heading = {
          colors.lavender,
          colors.blue,
          colors.sapphire,
          colors.teal,
          colors.green,
          colors.yellow,
        }
        local hl = {
          ["@markup.strong"] = { fg = colors.text, bold = true },
          ["@markup.italic"] = { fg = colors.text, italic = true },
          ["@markup.quote"] = { fg = colors.subtext0 },
        }
        for i, color in ipairs(heading) do
          hl["@markup.heading." .. i .. ".markdown"] = { fg = color, bold = true }
          -- render-markdown's H*/H*Bg are computed from catppuccin's rainbow*
          -- groups inside its integration, so overriding rainbow* here wouldn't
          -- reach them -- they have to be set directly.
          hl["RenderMarkdownH" .. i] = { fg = color, bold = true }
          hl["RenderMarkdownH" .. i .. "Bg"] = { bg = U.darken(color, 0.095, colors.base) }
        end
        return hl
      end
      return opts
    end,
  },
  {
    "f-person/auto-dark-mode.nvim",
    lazy = false,
    priority = 1000,
    opts = {
      update_interval = 3000,
      set_dark_mode = function()
        vim.o.background = "dark"
        vim.cmd.colorscheme("catppuccin-mocha")
      end,
      set_light_mode = function()
        vim.o.background = "light"
        vim.cmd.colorscheme("catppuccin-latte")
      end,
    },
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = function()
        local is_dark = true
        if vim.fn.executable("defaults") == 1 then
          local handle = io.popen("defaults read -g AppleInterfaceStyle 2>/dev/null")
          if handle then
            is_dark = handle:read("*a"):match("Dark") ~= nil
            handle:close()
          end
        end
        vim.o.background = is_dark and "dark" or "light"
        vim.cmd.colorscheme(is_dark and "catppuccin-mocha" or "catppuccin-latte")
      end,
    },
  },
}
