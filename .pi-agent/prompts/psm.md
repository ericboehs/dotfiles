---
description: Connect to a CyberArk PSM target from the GFE and drive its session agentically
argument-hint: "[target or instruction]"
---

Read `~/.pi/agent/skills/gfe-psm/SKILL.md` in full before doing anything — it is the
authoritative playbook (FreeRDP invocation, one-time-token rules, coordinate mapping,
failure modes). Do not improvise an alternative RDP client; the skill explains why the
obvious ones fail.

First work out **where you are**, because it changes every command:

- **On the GFE** (hostname `OKL-LTA106626`, or `~/.local/bin/psm` exists locally): run
  `psm` directly — `~/.local/bin/psm …` — and Read captures in place.
- **On Eric's Mac** (pi's usual home): `psm` runs on the GFE, so wrap commands with
  `ssh gfew '…'`, and `scp` captures back before reading them.

Then, in order:

1. If `~/.local/bin/psm` is missing on the GFE, deploy it from the Mac:
   `~/Code/github.com/ericboehs/claude-config/skills/gfe-psm/deploy.sh gfew`
   (this also installs the skill + this prompt onto the GFE).
2. Kill any stale watcher (`pkill -f "psm watch"`), then **arm the watcher before**
   asking me to download an `.rdp` — the token is single-use and ages in ~2 minutes.
3. Ask me to click **Connect → SSH** in PVWA. The watcher launches FreeRDP within
   ~0.2s and dismisses the VA security warning itself.
4. Capture (`psm shot`) until the shell prompt appears; budget ~45–60s. Then drive with
   `psm text` / `psm key` and read results the same way.

Ask: $@
