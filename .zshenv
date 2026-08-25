# .zshenv - runs for every zsh invocation, interactive or not.
#
# PATH lives here rather than in .zshrc because .zshrc is only read by
# interactive shells. Anything started with `zsh -c` — the tmux `bind C` pi
# launcher, a script, a command pi's own bash tool spawns — saw nothing but the
# system PATH, so ~/bin, ~/.local/bin and the mise shims were all missing.
#
# Sourced rather than inlined so there is still one list of directories.
# path.zsh declares `typeset -Ug path`, which is what keeps the prepend below
# idempotent across nested shells: duplicates are dropped, leftmost wins.
source "$HOME/.zsh/path.zsh"

# Shims go in front of everything path.zsh added, not behind it.
# ~/.local/share/aube ships its own `pi` and `codex`, and ~/bin a `slk`, so the
# order here decides which binary those three names resolve to. This is the
# order an interactive shell has always ended up with — tools.zsh used to do
# this prepend after .zshrc had sourced path.zsh — and moving it must not
# quietly hand `pi` over to aube.
path=("$HOME/.local/share/mise/shims" "$path[@]")
