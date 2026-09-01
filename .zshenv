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

# Machine-local env, the .zshenv counterpart to .zshrc's .zshrc.local. It has to
# be here rather than there because the things that need it are not interactive:
# a work box's AWS profile and gov-cloud regions, a Homebrew prefix that only
# path_helper adds and only for login shells, a rustup install. `ssh box cmd`
# reads this file and nothing else, so anything left to .zshrc is missing from
# exactly the ssh-driven runs — agent-notify --recv, cron, remote harvests —
# that most need it.
#
# Sourced last so a machine can override the block above, which means a bare
# prepend here lands in front of the mise shims: append (`path+=(...)`) unless
# shadowing a mise-managed tool is the actual intent.
#
# Spelled as `if` rather than `[[ … ]] && source …` for the reason .zshrc gives
# at its own local hook: the && form would leave $? = 1 when the file is absent.
if [[ -f "$HOME/.zshenv.local" ]]; then
  source "$HOME/.zshenv.local"
fi
