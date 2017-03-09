" Vroom for some reason defaults to './script/cucumber' here...
let g:vroom_cucumber_path = 'cucumber'

" Don't bundle exec; I'm using binstubs
let g:vroom_use_bundle_exec = 0

" Defaults to not use vimux even though it says it will
let g:vroom_use_vimux = 1

" Don't add --color to my commands; I got colors figured out
let g:vroom_ignore_color_flag = 1

" Use rake test for minitest
let g:vroom_test_unit_command = 'rails test'
