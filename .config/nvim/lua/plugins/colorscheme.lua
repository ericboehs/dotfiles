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
