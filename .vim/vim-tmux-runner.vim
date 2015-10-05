" Open runner pane (needed for the other command below)
map <Leader>vo :VtrOpenRunner<CR>

" Send lines to buffer
map <Leader>vs :VtrSendLinesToRunner<CR>

" Prompt for a command to run
map <Leader>vc :VtrSendCommandToRunner<Space>

" Run last command executed by VtrSendCommandToRunner
map <Leader>vl :VtrSendCommandToRunner<CR>

" Focus runner pane
map <Leader>vf :VtrFocusRunner<CR>

" Close runner pane
map <Leader>vq :VtrKillRunner<CR>
