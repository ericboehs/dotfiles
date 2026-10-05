---
description: Review a coding session and list changes to the agent's environment, most severe first
argument-hint: "[session file, session id, or description; default is this session]"
source: https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/retro/SKILL.md
license: MIT, Copyright (c) 2026 Matt Pocock, full text in .pi-agent/licenses/mattpocock-skills.txt
---

Run a retrospective on a coding session. Session to review: ${@:-this current session}

You are looking for changes to the coding agent's environment that would make future runs go better. The environment is everything around the code: instructions, agent definitions, checks, tools, and the information the agent can reach. Do not suggest changes to the application itself, and do not make any change yet. List them for me.

This prompt is adapted from Matt Pocock's `retro` skill, which is under the MIT License.

## Step 1: Read the writing guide, if you can

Matt Pocock's `writing-for-agents` guide explains how to write instructions that agents follow. It is under the same MIT License. Fetch it from https://raw.githubusercontent.com/mattpocock/skills/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/productivity/writing-for-agents/SKILL.md and use it when you word your suggestions. If you cannot fetch it, skip this step and say so.

## Step 2: Read the session

If I did not name a session, review this conversation.

Otherwise, find the session log. Pi saves each session as a JSON Lines file, one event per line, under `~/.pi/agent/sessions/--<working directory, with each slash replaced by a dash>--/<timestamp>_<session id>.jsonl`. The `sessionDir` setting or the `PI_CODING_AGENT_SESSION_DIR` environment variable can move that folder. List the newest files with `ls -t`, and use `rg` to find a session by id or by words from it.

Session files can be large. Search them with `rg` and read only the parts you need, rather than reading a whole file at once.

Subagents run with `--no-session`, so their own steps are not saved. Only each subagent's final message appears, inside the parent session's tool results. Say so if that limits what you can see.

## Step 3: Read the environment

Before you suggest anything, read what already exists, so that you do not suggest something the repository already has:

- Instruction files: `AGENTS.md` or `CLAUDE.md` in the repository and its parent folders, and `~/.pi/agent/AGENTS.md`.
- Review rules: `CODING_STANDARDS.md` or similar, if there is one.
- Agent definitions: `~/.pi/agent/agents/*.md` and the repository's `.pi/agents/*.md`.
- The repository's own check command: its `package.json` scripts, `Makefile`, `Rakefile`, `mise.toml` tasks, or scripts in `bin/`.
- Its guardrails: pre-commit and pre-push hooks, and its continuous integration (CI) workflow files.

## Step 4: Look for improvements in these categories

- **Navigation.** How easily did the agent find the right files? Are there hidden links between files? Would a short pointer, such as "the schema for X is in Y," in an instruction file or a doc have saved time? Use this when the session spent a long time finding something.
- **Automated checks.** Could a check have caught a mistake the agent made: a linter, a type checker, a test, or a check on file locations? Start from the repository's own check command and CI workflow. A check that exists but is not wired in, or is silently broken, is the finding; do not suggest building it again. A repository with no guardrail, meaning no pre-commit hook and no CI job that runs its lint, type check, or test command, is a finding on its own. Use this when the agent made a mistake a check could have caught, or when the repository has no guardrail at all.
- **Coding standards.** Should the reviewer get a new rule, or should a rule be removed or made clearer? First decide what kind of violation it is. A mechanical violation, such as a fixed pattern, a banned function, an import shape, or a rule about where files go, needs a check that runs every time: a custom rule in the repository's own linter, a pre-commit hook, or a CI job, whichever is cheapest for that repository. Prefer building the check over writing the rule down. Keep `CODING_STANDARDS.md` for judgement calls that no check can make, such as consistency across files or matching the surrounding style. Use this when the reviewer missed a mistake.
- **Large instruction files.** Are there instructions in `AGENTS.md`, in the repository or in `~/.pi/agent/`, that belong in the coding standards or in an automated check instead? Use this when an instruction file is long.
- **Tool use.** Did the agent make expensive tool calls that could be cheaper, such as reading whole large files, repeating the same search, or running a slow command more than once? Is any custom tool, command line program, or extension wasteful with tokens? Use this when the session made an expensive call.
- **Instructions that change nothing.** Are there instructions in the instruction files or agent definitions that do not change what the agent does? Use this when those files are long.
- **Information access.** Was the agent missing something important that it could have been given, such as development server logs written to a file, or read-only access to an outside service? Use this when the agent could not see something it needed.

## Step 5: Report

List the suggestions in order of severity, most severe first:

- **High:** the gap caused a wrong result, a hidden failure, or work that had to be redone.
- **Medium:** the gap cost a lot of time or tokens, but the result was right.
- **Low:** a tidy-up that would make the next run a little easier.

For each suggestion, give the category, what happened in the session (quote the message or command), the change you suggest, and the file or place it belongs. Leave out a category with nothing to report.

## Background

### Building and reviewing

Work goes through two stages: building and review. The builder carries the most context. It explores, writes code, and debugs failures. The reviewer carries the least. It receives a diff, so it needs no exploration and usually writes no code. So the reviewer, not the builder, should enforce coding standards. In the `/team` setup, the builders are `builder-a` and `builder-b`, and the reviewer is the `adversary` at its done gate.

### Where each kind of change belongs

- `AGENTS.md` or `CLAUDE.md` is added to the context of every agent that works in the folder. Use it sparingly, mostly for short pointers to other files.
- `CODING_STANDARDS.md` is read during review, not while building. If it grows past about 1,000 lines, split it into docs and point to them.
- Docs are reference files that other files point to. Look for an existing doc before writing a new one.
- Skills are good for reference material, because only their name and description sit in the context until they are needed. Prompt templates, such as this one, are good for commands the user runs on purpose, because they cost nothing until typed.
