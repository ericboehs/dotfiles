./freshrc:56:13:  fresh vim/leader.vim
./vim/keybindings.vim:27:7:nmap <leader>ss :source $HOME/.vimrc<CR>
./vim/keybindings.vim:30:16:nmap <silent> <leader>oo :!open http://
./vim/keybindings.vim:31:16:nmap <silent> <leader>ol :!open http://localhost:3000<CR><CR>
./vim/keybindings.vim:34:16:nmap <silent> <leader>kzz :!tmux kill-window -t 5 && tmux new-window -n zeus "zeus start" && tmux set-window-option -t $SESSION:5 monitor-activity off && tmux send-keys -t 4.1 C-c; sleep 0.5; tmux send-keys -t 4.1 C-l; sleep 0.5; tmux send-keys -t 4.1 zeus\ s C-m && tmux new-window -n zeus "zeus start" && tmux select-window -t 2<CR><CR>
./vim/keybindings.vim:35:16:nmap <silent> <leader>kzt :!tmux kill-window -t 5 && tmux new-window -n zeus "zeus start" && tmux set-window-option -t $SESSION:5 monitor-activity off && tmux select-window -t 2<CR><CR>
./vim/keybindings.vim:36:16:nmap <silent> <leader>kzc :!tmux send-keys -t 4.0 C-c; sleep 0.5; tmux send-keys -t 4.0 C-d; sleep 0.5; tmux send-keys -t 4.0 C-l; sleep 0.5; tmux send-keys -t 4.0 zeus\ c C-m && tmux select-window -t 2<CR><CR>
./vim/keybindings.vim:37:16:nmap <silent> <leader>kzs :!tmux send-keys -t 4.1 C-c; sleep 0.5; tmux send-keys -t 4.1 C-l; sleep 0.5; tmux send-keys -t 4.1 zeus\ s C-m && tmux select-window -t 2<CR><CR>
./vim/keybindings.vim:49:6:map <leader>n :NERDTreeToggle<CR>
./vim/keybindings.vim:50:6:map <leader>N :NERDTreeFind<CR>
./vim/keybindings.vim:52:13:" Ack with <leader>f
./vim/keybindings.vim:56:11:nnoremap <leader>h *<C-O>
./vim/keybindings.vim:58:11:nnoremap <leader>H *<C-O>:AckFromSearch!<CR>
./vim/keybindings.vim:63:16:nmap <silent> <leader>d "_d
./vim/keybindings.vim:64:16:vmap <silent> <leader>d "_d
./vim/leader.vim:1:8:let mapleader = "\\"
