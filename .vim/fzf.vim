" Enable fzf fuzzy search
set rtp+=/opt/homebrew/bin/fzf " FZF is maintained via homebrew
nnoremap <C-p> :<C-u>Files<CR>
nnoremap <Leader>R :<C-u>RG<CR>
vnoremap <Leader>R <Esc>:<C-u>RG <C-r><C-w><CR>

autocmd! FileType fzf set laststatus=0 noshowmode noruler nonumber norelativenumber
  \| autocmd BufLeave <buffer> set laststatus=2 showmode ruler

function! RipgrepFzf(query, fullscreen)
  let command_fmt = 'rg --column --line-number --hidden --no-heading --color=always --smart-case -- %s || true'
  let initial_command = printf(command_fmt, shellescape(a:query))
  let reload_command = printf(command_fmt, '{q}')
  let spec = {'options': ['--phony', '--query', a:query, '--bind', 'change:reload:'.reload_command]}
  call fzf#vim#grep(initial_command, 1, fzf#vim#with_preview(spec), a:fullscreen)
endfunction

command! -nargs=* -bang RG call RipgrepFzf(<q-args>, <bang>0)
