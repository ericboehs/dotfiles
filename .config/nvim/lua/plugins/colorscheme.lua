return {
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
        local handle = io.popen("defaults read -g AppleInterfaceStyle 2>/dev/null")
        local is_dark = handle and handle:read("*a"):match("Dark") ~= nil or false
        if handle then
          handle:close()
        end
        vim.o.background = is_dark and "dark" or "light"
        vim.cmd.colorscheme(is_dark and "catppuccin-mocha" or "catppuccin-latte")
      end,
    },
  },
}
