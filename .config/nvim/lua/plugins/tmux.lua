return {
  -- nvim-tmux-navigation used to live here. Its Ctrl-hjkl handoff called
  -- `tmux select-pane` directly, which stops at the edge of the tmux window;
  -- config/keymaps.lua now calls ~/.tmux/pane-nav.sh instead, which carries on
  -- into the next window/session exactly like the tmux bindings do.
  {
    "christoomey/vim-tmux-runner",
    cmd = { "VtrSendCommandToRunner", "VtrOpenRunner", "VtrFlushCommand", "VtrClearRunner" },
  },
}
