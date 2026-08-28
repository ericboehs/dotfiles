# Instant prompt is off. It painted a fake prompt before syntax highlighting
# and autosuggestions were hooked, so a paste in a new pane flashed raw
# bracketed-paste `200~` until the real prompt took over. Set this here
# (before the cache would have loaded) and in ~/.p10k.zsh so p10k does not
# regenerate an enabled cache.
typeset -g POWERLEVEL9K_INSTANT_PROMPT=off
