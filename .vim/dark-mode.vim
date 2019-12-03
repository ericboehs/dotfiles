function! SetBackgroundMode(...)
    let s:new_bg = "light"

    if $TERM_PROGRAM ==? "Apple_Terminal"
        let s:mode = systemlist("defaults read -g AppleInterfaceStyle")[0]

        if s:mode ==? "dark"
            let s:new_bg = "dark"
        else
            let s:new_bg = "light"
        endif
    endif

    if &background !=? s:new_bg
        let &background = s:new_bg

        silent execute "!go-" . s:new_bg
        silent execute "!tmux source-file ~/.tmux/tmuxline." . s:new_bg . ".conf"
    endif
endfunction

call SetBackgroundMode()
call timer_start(3000, "SetBackgroundMode", {"repeat": -1})
