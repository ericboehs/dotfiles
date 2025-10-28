-- lua/plugins/vimade.lua
return {
  "TaDaa/vimade",
  init = function()
    vim.g.vimade = {
      enablefocusfading = 1, -- enable tmux focus events for pane switching
      fadelevel = 0.4,       -- adjust fade intensity (0.0–1.0)
      animate = 1,           -- enable smooth fade transitions
      ncmode = 'windows',    -- fade inactive vim windows
      checkinterval = 100,   -- faster checks to reduce lag
    }
  end,
}
