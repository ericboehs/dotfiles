" Attach runner pane
map <Leader>va :VtrAttachToPane<CR>

" Open runner pane (needed for the other command below)
map <Leader>vo :VtrOpenRunner<CR>

" Send lines to buffer
map <Leader>vs :VtrSendLinesToRunner<CR>

" Prompt for a command to run
map <Leader>vc :VtrSendCommandToRunner<Space>

" Clear runner
map <Leader>vcr :VtrClearRunner<CR>

" Run last command executed by VtrSendCommandToRunner
map <Leader>vl :VtrSendCommandToRunner<CR>

" Focus runner pane
map <Leader>vf :VtrFocusRunner<CR>

" Close runner pane
map <Leader>vq :VtrKillRunner<CR>

" Send Ctrl-D to Pane
map <Leader>vd :VtrSendCtrlD<CR>
