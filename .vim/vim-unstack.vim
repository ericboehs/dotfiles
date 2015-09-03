" Split vim windows vertical instead of horizontally
let g:unstack_layout = "portrait"

" Match cucumber backtraces
let g:unstack_extractors = unstack#extractors#GetDefaults() + [unstack#extractors#Regex('\v^([^:]+):([0-9]+).+', '\1', '\2')]
