---
description: Run one adversary gate (interface, repeated failure, or done) on the current work
argument-hint: "<interface | repeated-failure | done> [what to check]"
---

Run the adversary at one gate. Gate: **$1**. My notes, if any: ${@:2}

Start the `adversary` subagent with the `subagent` tool. It is a deferred tool, so if it is not in your tool list, find it with `tool_search` first. The adversary starts with no memory of this conversation, so put everything it needs in the task. Do not ask it to fix anything; it refuses to edit and only attacks.

Name the gate in the task and send the material for that gate:

| Gate | When to run it | What to send | Question it answers |
| --- | --- | --- | --- |
| `interface` | Before an interface locks, before either side writes code against it. | Both sides' proposed contracts, word for word. | Do both sides agree? It names each mismatch in one sentence and does not rewrite either side. |
| `repeated-failure` | When the same test has failed twice. | The test, both failures, and the change that made it pass or the current diff. | Was it fixed, or only hidden? Hidden means the assertion was weakened, the test was skipped, or the test now checks a different case. It names the line. |
| `done` | Before anyone calls the task done. | The full diff, the agreed contract, and the commands that check the work. | What still breaks? It signs off only if it tried and could not break it. |

If I did not name a gate, pick the one that matches where the work is, and tell me which one you picked.

The adversary hands back exactly this:

```text
Gate: <interface | repeated failure | done>
Verdict: <agree or disagree | fixed or hidden | sign off or not done>
<One sentence with the reason. For a mismatch or a break, one sentence for each.>
```

Show me that hand-back word for word. Do not soften it, add to it, or act on it until I say so. A task is not done until the done gate says `sign off`.
