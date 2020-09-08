" Enable fzf fuzzy search
set rtp+=/usr/local/opt/fzf " FZF is maintained via homebrew
nnoremap <C-p> :<C-u>FZF<CR>

autocmd! FileType fzf set laststatus=0 noshowmode noruler nonumber norelativenumber
  \| autocmd BufLeave <buffer> set laststatus=2 showmode ruler
