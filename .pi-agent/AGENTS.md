# About Eric

## Personal
- Daily notes in `~/Documents/Wiki/daily/` (YYYY-MM-DD.md format, weekly notes YYYY-Www.md)

## Work
- **Role:** Engineer on EERT (Engineering Excellence Response Team) at VA
- **Company:** Oddball (federal contractor)
- **Focus areas:** Developer tooling, platform engineering
- **Team:** Alex Teal (lead)

## Tech Preferences
- **Languages:** Ruby/Rails preferred, comfortable with shell scripting
- **Style:** Command line junky - prefer CLI tools over GUIs

## Response Style
- After completing a task or stopping, always present 3 suggested next actions prefixed with "Next steps:" as numbered options (1, 2, 3). Each option should represent a different direction (not sequential steps). They should be concrete, ready-to-send messages (not open-ended questions requiring reflection). The user should be able to just reply with a number and work continues.

# Code Directory Structure

My code lives in `~/Code` and follows the `host/org/repo` structure:
- `~/Code/github.com/org/repo` → github.com/org/repo (e.g., `~/Code/github.com/ericboehs/dotfiles`)
- `~/Code/va.ghe.com/org/repo` → va.ghe.com/org/repo (e.g., `~/Code/va.ghe.com/software/eert`)

# Tool Preferences

## Git
- Never use `git commit --no-verify` to bypass hooks
- Prefer conventional commits when appropriate

## GitHub
- When posting issues, PRs, comments, or review replies on my behalf, sign off with `— 🤖 <model>, posting on behalf of @ericboehs` (DHH's convention), e.g. `— 🤖 Muse 1.3, posting on behalf of @ericboehs`. Never guess `<model>` from the system prompt. In pi, get it via the bash tool with `pi-model-name` (uses `$PI_PROVIDER`/`$PI_MODEL`, prints pretty name like `Muse 1.3` or `Opus 5`); if the script is missing, use `printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"` output verbatim.

## Research
- **Use `qmd` to search Eric's knowledge base**: `qmd query "..."` (hybrid) or `qmd search "..."` (fast); scope with `-c <collection>` (`qmd collection list` shows them: `wiki`, `sessions`, `email`, `va-*` repos)
  - Before asking Eric to re-explain prior work, search the `sessions` collection first
- **Slack:** Prefer `slk` CLI for Slack data (messages, search, unread, status).

## Credentials
- Prefer the **1Password CLI (`op`)** for all secrets; see skill `credentials` for syntax + reducing biometric prompts.
- **Never** write secret values to files, docs, issues, PRs, commits, or memory — treat them as ephemeral (pipes/args only).
