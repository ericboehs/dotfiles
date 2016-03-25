# While true do command, clear, sleep
function wt() { while; do $*; clear; sleep 1; done }

# Unti command returns 0, do command, clear, sleep
function ut() { clear && until $*; do clear; sleep 1; done }
