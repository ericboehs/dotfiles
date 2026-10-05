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
| claude-fleet → `claude-config/bin/claude-fleet` | 2026-06-18 | Fleet-wide Claude session status from transcript JSONL |
| claude-jsx-to-html | never | Claude Desktop JSX artifact to standalone HTML |
| claude-man (+ CLAUDE_MAN_README.md) | 2025-12-23 | tmux manager for Claude CLI sessions |
| claude-manager-slack-poller | never | Poll Slack for a message from Eric, then exit |
| claude-manager-tickler → `claude-config/bin/` | never | Wait on the Claude Manager events queue, exit when events land |
| claude-send → `claude-config/bin/` | never | Manager dispatch: send a prompt to a worker Claude pane |
| claude-watch → `claude-config/bin/` | never | Watch the manager queue, exit with new events |
| claude-watcher | never | Tail a Claude session log's tool calls |
| monitor_tmux_pane | never | Notify when a tmux pane running Claude goes idle |

`claude-config/install.sh` symlinks every `claude-config/bin/*` into `~/bin`,
which is this repo's `bin/`. Running it again puts the four claude-config links
back in `bin/`. claude-dashboard (last run 2026-02) shells out to `claude-send`
for its send action, so that action fails until `claude-send` is on PATH again.

## Stale

| Script | Last run | What it did |
|---|---|---|
| clf | 2021-05-20 | Find a gem's changelog URL via rubygems.org |
| code-editor | never | Switch tmux to the 👨🏼‍💻 session, which no longer exists |
| gh-labeler | 2022-11-04 | Remove labels in bulk from GitHub issues (GraphQL) |
| ghb | 2022-08-30 | gh workflow helper for the current branch |
| llama-coder | never | Qwen3-Coder-Next via llama-server |
| mksh | 2025-10-23 | Create an executable bash script and open it in $EDITOR |
| ollama-search | 2025-12-20 | Search and explore Ollama models |
| refresh_safari | 2020-02-28 | Reload Safari's front document (was the `rfs` abbreviation) |
| slack-slash-slash | 2021-05-17 | Turn https://*.slack.com URLs into slack:// URLs |
| watch-copilot-reviews | never | Wait for Copilot PR reviews. Replaced by the agent-plugins gh-copilot-review skill |
| yt → `yt/yt` (+ yt-assets/) | 2022-03-23 | YouTube app. Its LaunchAgent was already `.disabled` |
