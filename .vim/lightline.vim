let g:lightline = { 'colorscheme': 'solarized' }
let g:tmuxline_separators = { 'left' : '', 'left_alt': '', 'right' : '', 'right_alt' : '', 'space' : ' ' }

function SetTmuxLineColorPreset()
  let theme = tmuxline#load_colors("lightline")
  let bgcolor_zoomed = 'colour' + theme['a'][1]
  let bgcolor = 'colour' + theme['cwin'][1]

  let g:tmuxline_preset = {
    \ 'a': '#S',
    \ 'win': '#I #W',
    \ 'cwin': '#{?window_zoomed_flag,#[bg=' . bgcolor_zoomed . '],#[bg=' . bgcolor . ']}#I #W',
    \ 'x': '%a,\ %b\ %-d %-l:%M:%S%p',
    \ 'y': '#(~/bin/utcdate)',
    \ 'z': '#h',
    \ 'options': {
      \ 'status-justify': 'left',
      \ 'status-interval': '1',
      \ } }
  call tmuxline#set_statusline("lightline")
endfunction
