---
description: Connect to a CyberArk PSM target from the GFE and drive its session agentically
argument-hint: "[target or instruction]"
---

Read `~/.claude/skills/gfe-psm/SKILL.md` in full before doing anything — it is the
authoritative playbook (FreeRDP invocation, one-time-token rules, coordinate mapping,
failure modes). Do not improvise an alternative RDP client; the skill explains why the
obvious ones fail.

Then, in order:

1. If `~/.local/bin/psm` is missing on the GFE:
   `~/Code/github.com/ericboehs/claude-config/skills/gfe-psm/deploy.sh gfew`
2. Kill any stale watcher (`ssh gfew 'pkill -f "psm watch"'`), then **arm the watcher
   before** asking me to download an `.rdp` — the token is single-use and ages in
   ~2 minutes.
3. Ask me to click **Connect → SSH** in PVWA. The watcher launches FreeRDP within
   ~0.2s and dismisses the VA security warning itself.
4. Capture (`psm shot` → `scp` → look at the PNG) until the shell prompt appears;
   budget ~45–60s. Then drive with `psm text` / `psm key` and read results the same way.

Ask: $@
