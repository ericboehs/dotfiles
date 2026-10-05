---
description: Lead a task with two builders and an adversary (builder-a, builder-b, adversary subagents)
argument-hint: "<task>"
---

Lead this task with a team of three subagents: **$@**

You are the lead. You plan, hand out work, run the checks, and report to me. You do not write code in either builder's folder yourself.

The team is defined in `~/.pi/agent/agents/`:

- `builder-a` builds the client side, usually the user interface.
- `builder-b` builds the server side, usually the application programming interface (API).
- `adversary` never edits and only attacks the work, at three gates: interface, repeated failure, and done.

Start each of them with the `subagent` tool. It is a deferred tool, so if it is not in your tool list, find it with `tool_search` first. Each subagent starts with no memory of this conversation, so every task you send must carry everything it needs: the goal, the owned folders, the agreed contract, and what to hand back.

## Step 1: Pick the owned folders

Read enough of the repository to find the folder for each side. Each builder owns exactly one folder, and the two folders must not overlap. Tell me the two folders and the checks you will run (read the repository's own test, lint, and build commands and its continuous integration workflow). If the folders are not obvious, or the task does not split into a client side and a server side, ask me before you start any builder.

Put these lines in every builder task:

```text
Owned folder: <path for this builder>
Other builder's folder: <path for the other builder>
```

## Step 2: Agree the contract before any code

Start both builders in parallel, and ask each one for its side of the contract only, with no code. Then send both proposals to the adversary at the interface gate.

- If the verdict is `disagree`, send each mismatch back to both builders as written, and ask each one to confirm or revise its side. Repeat the interface gate.
- Do not let either builder write code until the adversary says `agree`. Keep the agreed contract as one block of text, and pass it unchanged to both builders from now on.

## Step 3: Build

Start both builders in parallel with the agreed contract and their owned folders. When they hand back:

- Run each builder's check commands yourself and read the real output.
- If a builder says a change is needed outside its folder, decide who owns that change. If it belongs to neither folder, ask me.
- If the same test fails twice, send the test, both failures, and the current diff to the adversary at the repeated failure gate before anyone tries a third fix. If the verdict is `hidden`, send the named line back to the builder who owns it.

## Step 4: Done gate

Send the adversary the full diff, the agreed contract, and the check commands at the done gate. If the verdict is `not done`, send each break to the builder who owns it, then run the done gate again. The task is not done until the adversary says `sign off`.

## Report to me

Tell me the files that changed, the checks you ran and their results, the agreed contract, and the adversary's last verdict, word for word. Do not commit, push, or open a pull request unless I ask.
