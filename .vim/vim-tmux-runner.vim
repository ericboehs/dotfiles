" Attach runner pane
map <Leader>va :VtrAttachToPane<CR>

" Open runner pane (needed for the other command below)
map <Leader>vo :VtrOpenRunner {'percentage': 50}<CR>

" Send lines to buffer
map <Leader>vs :VtrSendLinesToRunner<CR>

" Prompt for a command to run
map <Leader>vc :VtrSendCommandToRunner<Space>

" Run rails c
map <Leader>vcr :VtrSendCommandToRunner rails c<CR>

" Prompt for a command to run
map <Leader>vct :VtrSendCommandToRunner rails test <C-r>%:<C-r>=line('.')<CR><CR>

" Run last command executed by VtrSendCommandToRunner
map <Leader>vl :VtrSendCommandToRunner<CR>

" Focus runner pane
map <Leader>vf :VtrFocusRunner<CR>

" Send Ctrl-D to Pane
map <Leader>vd :VtrSendCtrlD<CR>

" Send 'Gq' to runner pane
map <Leader>vgq :VtrSendCommandToRunner Gq<CR>

" Send 'q' to runner pane
map <Leader>vq :VtrSendCommandToRunner q<CR>
