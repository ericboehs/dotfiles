lua << EOF
  require('telescope').setup{
    defaults = {
      vimgrep_arguments = {
	'rg',
	'--color=never',
	'--no-heading',
	'--with-filename',
	'--line-number',
	'--column',
	'--smart-case',
	'--hidden'
      }
    }
  }
EOF
nnoremap <leader>ff <cmd>Telescope find_files find_command=rg,--ignore,--hidden,--files<cr>
nnoremap <leader>fg <cmd>Telescope live_grep<cr>
nnoremap <leader>fb <cmd>Telescope buffers<cr>
nnoremap <leader>fh <cmd>Telescope help_tags<cr>
