let g:ale_linters = {
   \ 'javascript': ['eslint']
   \ }
let g:ale_fixers = {
   \ 'javascript': ['eslint'],
   \ 'ruby': ['rubocop']
   \ }

map <Leader>af :ALEFix<cr>
