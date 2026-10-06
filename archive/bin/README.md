# Archived bin scripts

Scripts retired from `bin/`. They are out of `$PATH` (`~/bin` links to `bin/`,
not this directory) and out of `bin/shell-lint` and `bin/script-lint`, so
nothing here is maintained. They are kept, not deleted, so one can come back
with a `git mv` instead of a dig through history.

Archived 2026-10-05 after a usage audit of shell history (e14, coop, gfew) and
pi sessions (since 2026-05-12). "Never" means no invocation in either source.

To restore one: `git mv archive/bin/<name> bin/`. Symlinks here carry one
extra `../` so they still resolve. Take it off again when moving it back.

## Never run

| Script | What it did |
|---|---|
| autolights.sh | Turn lights on/off when the camera starts (log stream on AVFCapture) |
| bodmd | Render `bundle outdated --parseable` output as a markdown table |
| constant-ping | Ping google.com into ~/tmp/constant_ping.log |
| dash-ghrv | gh-dash action: show the failed run log for the current PR |
| dash-ghrvr | gh-dash action: same, filtered to rspec failures |
| devin | Lightweight Devin CLI with an fzf session picker |
| full_mfa | `op signin` + VA AWS MFA, written into ~/.zshrc.local |
| gbzp | Interactive git branch checkout with fzf preview |
| gh-job-attempts | List every attempt of a GitHub Actions job |
| gh-reruns | Rerun a failed Actions job up to N times |
| gh-reviews-by-user | PRs reviewed by a user since a date |
| ghmpr | fzf-pick a PR awaiting my review and check it out |
| ghp | List issues in the VA GitHub project (927) |
| internet | Packet-loss ping tests against a series of hosts |
| parse-argocd-jwt | Decode the ArgoCD JWT |
| pbpastes | Stream the clipboard, printing each change |
| propresenter-status | Read-only ProPresenter status |
| slack-reader → `slackdumper/slackdump_reader.sh` | Read slackdumper output (replaced by `slk`) |
| slackdumper → `slackdumper/slackdumper.sh` | Dump Slack channels (replaced by `slk`) |
| ssm-param-archive | Move vets-api SSM parameters under /archived (or back) |
| ssm-param-history-new | Rewrite of `ssm-param-history` that never replaced it |
| stopwatch | Terminal stopwatch |
| toggle_notes_pane | Join or split a 📝 tmux notes pane |
| ytdl | yt-dlp wrapper |

## Claude Code tooling

| Script | Last run | What it did |
|---|---|---|
| clapilot-sandbox | never | clapilot inside the claude-sandbox container |
| clauki | never | Claude Code via Fireworks FirePass (Kimi K2.5 Turbo) |
| claude-code-proxy-or → `claude-code-proxy/claude-code-proxy` | never | OpenRouter proxy binary for Claude Code |
| claude-cred-push | never | Copy this Mac's Claude Code login to another machine's keychain |
| claude-fleet → `claude-config/archive/bin/claude-fleet` | 2026-06-18 | Fleet-wide Claude session status from transcript JSONL |
| claude-jsx-to-html | never | Claude Desktop JSX artifact to standalone HTML |
| claude-man (+ CLAUDE_MAN_README.md) | 2025-12-23 | tmux manager for Claude CLI sessions |
| claude-manager-slack-poller | never | Poll Slack for a message from Eric, then exit |
| claude-manager-tickler → `claude-config/archive/bin/` | never | Wait on the Claude Manager events queue, exit when events land |
| claude-send → `claude-config/archive/bin/` | never | Manager dispatch: send a prompt to a worker Claude pane |
| claude-watch → `claude-config/archive/bin/` | never | Watch the manager queue, exit with new events |
| claude-watcher | never | Tail a Claude session log's tool calls |
| monitor_tmux_pane | never | Notify when a tmux pane running Claude goes idle |

The seven claude-config links (here and under Claude Code session tools) point
into `claude-config/archive/bin`, where claude-config parks the scripts it no
longer installs. Its `install.sh` links only `claude-config/bin/*` into `~/bin`,
which is this repo's `bin/`, and also skips any name with an entry here. To
restore one, `git mv` it back to `claude-config/bin/`, delete its link here, and
rerun install.sh.
claude-dashboard (last run 2026-02) shells out to `claude-send` for its send
action, so that action fails until `claude-send` is on PATH again.

## Claude Code launchers

Wrappers that pointed Claude Code at another provider or into a container.
Not used anymore (Eric, 2026-10-05).

| Script | Last run (count) | What it did |
|---|---|---|
| clapilot | 2026-08-06 (492) | Claude Code via the GitHub Copilot proxy. Took the `clap`, `clapd`, `clapr` and `clapdr` abbreviations with it |
| claor | 2026-07-30 (15) | Claude Code via OpenRouter |
| copilot-usage | 2026-07-20 (21) | Watch Copilot premium-request use, projection and overage cost from the proxy's `/usage` on :4141 |
| clas | 2026-06-22 (4) | Claude Code via Synthetic.dev (GLM-5.2) |
| clacer | 2026-03-31 (30) | Claude Code via Cerebras (GLM 4.7) through claude-code-proxy |
| cerebras-usage | 2026-03-19 (16) | Cerebras daily request/token remainders from rate-limit headers |
| ccc | 2026-02-27 (2) | Claude Cerebras Client |
| claude-sandbox | 2026-02-16 (13) | Claude Code in a container with scoped credentials |
| cco → `nikvdp/cco/cco` | 2026-02-16 (16) | nikvdp's sandboxed Claude Code launcher |
| sandbox → `nikvdp/cco/sandbox` | never | cco's sandbox helper |

`.claude/scripts/statusline.sh` lost its Cerebras segment (the :8083 proxy
context override, quota probe and `pace_projected` helper) and its Copilot
segment (the :4141 context branch and premium-request quota and pace) with them.

## Claude Code session tools

Readers, pickers and minders for Claude Code sessions. Not run since July
2026 at the latest; `claude --resume` covers the picker.

| Script | Last run (count) | What it did |
|---|---|---|
| claude-babysit | 2026-07-27 (56) | Watch a tmux pane running Claude and restart it after a crash |
| claude-browser | 2026-07-15 (2) | Browse, search and view Claude Code context surfaces |
| claude-active → `claude-config/archive/bin/` | 2026-04-16 (51) | List active Claude Code sessions in fzf |
| claude-tail → `claude-config/archive/bin/` | 2026-04-16 (92) | Show assistant messages from a session |
| claude-resume | 2026-04-15 (13) | fzf session picker with message search |
| daily-ai-sessions | 2026-02-27 (22) | Browse and resume Claude sessions linked from daily notes |
| claude-sessions → `claude-config/archive/bin/` | 2026-01-03 (21) | Status of all sessions, for the manager Claude |

## Stale

| Script | Last run | What it did |
|---|---|---|
| brave-search | 2026-08-27 | Web search through the Brave Search API. pi's web_search has a Brave backend |
| chatgpt-history → `chatgpt-history/chatgpt-history` | 2026-03-01 | ChatGPT conversation history via Safari |
| clf | 2021-05-20 | Find a gem's changelog URL via rubygems.org |
| code-editor | never | Switch tmux to the 👨🏼‍💻 session, which no longer exists |
| colors | 2021-08-30 | Print the 256-color test pattern |
| contagent → `contagent/contagent` | 2026-09-18 | Sandboxed coding agent launcher |
| earl | 2026-04-16 | Run the EARL bot from ~/.local/share/earl under fnox's production profile |
| gh-action-trace | 2026-03-25 | Find direct and transitive uses of a GitHub Action |
| gh-labeler | 2022-11-04 | Remove labels in bulk from GitHub issues (GraphQL) |
| gh-pm | 2025-11-20 | fzf picker over `gh pm list`. The gh-pm extension itself stays installed |
| ghb | 2022-08-30 | gh workflow helper for the current branch |
| llama-coder | never | Qwen3-Coder-Next via llama-server |
| llama-serve | 2026-02-25 | Switch llama.cpp models |
| mksh | 2025-10-23 | Create an executable bash script and open it in $EDITOR |
| ollama-search | 2025-12-20 | Search and explore Ollama models |
| omlx-pull | 2026-08-23 | Pull a Hugging Face model repo into ~/.omlx/models |
| pbcopy-decrypt | 2026-02-24 | Decrypt age-encrypted clipboard contents |
| pbpaste-enc | 2026-02-24 | Encrypt clipboard contents with age |
| pearl → `pearl-agents/bin/pearl` | 2026-04-21 | PEARL agent runner: Claude Code agents in Docker |
| pocket-speak | 2026-06-05 | Stream pocket-tts speech to the speakers |
| refresh_safari | 2020-02-28 | Reload Safari's front document (was the `rfs` abbreviation) |
| sermon-highlights | 2026-02-22 | ProPresenter screen items from a sermon .pages or .docx |
| slack-slash-slash | 2021-05-17 | Turn https://*.slack.com URLs into slack:// URLs |
| ssm-param-envs | 2026-01-23 | Which environments (dev, staging, sandbox, prod) have an SSM parameter |
| ssm-param-history | 2026-01-23 | Recently updated SSM parameters under a path |
| true-colors | 2021-08-30 | Test the terminal's true-color support |
| utcdate | 2020-01-29 | Print the time in UTC as HH:MMZ |
| va-pd-schedule | 2026-04-08 | List PagerDuty schedules, or who takes each shift for the next 6 months |
| watch-ci | 2026-02-04 | Watch CI for the current branch. The watch-ci skill ships its own copy |
| watch-copilot-reviews | never | Wait for Copilot PR reviews. Replaced by the agent-plugins gh-copilot-review skill |
| wso | 2026-01-04 | OpenCode workspace launcher |
| yt → `yt/yt` (+ yt-assets/) | 2022-03-23 | YouTube app. Its LaunchAgent was already `.disabled` |
