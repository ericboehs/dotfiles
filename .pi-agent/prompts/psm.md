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
2. Check PVWA's session: `pvwa-auth --status`. If it says `login required`, run
   `pvwa-auth` — it clicks through the sign-in state machine (welcome GO → PIV →
   warning Continue → PIV) and completes on its own when the card is unlocked. If it
   says `nothing clickable on the login page (card PIN prompt?)`, do **not** trust that
   diagnosis: it also prints this when the Apple-Events JS bridge cannot reach the page,
   and it exits `0` either way. `screencapture` and look — a visible `GO` button means
   you should drive the four clicks with `cliclick` per the skill; an actual PIN dialog
   is the only case where you ask me.
3. Kill any stale watcher (`pkill -f "psm watch"`), then **arm the watcher before**
   the download — the token is single-use and ages in ~2 minutes.
4. Get the `.rdp` into `~/Downloads`: either ask me to click **Connect → SSH** in PVWA,
   or run `pvwa-connect <target>` to drive Safari's PVWA DOM yourself (pair it with the
   armed watcher). The watcher launches FreeRDP within ~0.2s and dismisses the VA
   security warning itself — then check the target and click Yes on the PuTTY
   **security alert** (never blind-press Return there; it aborts the session).
5. Capture (`psm shot`) until the shell prompt appears; budget ~45–60s. Then drive with
   `psm text` / `psm key` and read results the same way. If you need to push files in,
   use typed base64 per the skill (clipboard paste wedges after one payload).

Ask: $@
