alias ls=lsd

opsi() {
  eval $(op signin)
  sed -i '' '/export OP_SESSION_my/d' ~/.zshrc.local
  env | grep OP_SESSION_my | sed -e 's/^/export /' >> ~/.zshrc.local
}

mfa() {
  source ~/Code/va.ghe.com/software/devops/utilities/issue_mfa.sh Eric.Boehs $1
  sed -i '' '/export AWS_/d' ~/.zshrc.local
  env | grep AWS_ | sed -e 's/^/export /' >> ~/.zshrc.local
}

# gcd/gvi: cd to a repo from its URL (github.com/ericboehs/gcd, cloned by bootstrap)
[[ -f ~/Code/github.com/ericboehs/gcd/gcd.sh ]] && source ~/Code/github.com/ericboehs/gcd/gcd.sh

# Write $1's enabledModels into $2. Follows symlinks so bootstrap links stay.
# jq -j matches pi's JSON.stringify(null, 2) (indent 2, no trailing newline).
_pi_copy_enabled_models() {
  local tmp
  tmp=$(mktemp) || return
  if jq -j --indent 2 --slurpfile s "$1" '.enabledModels = $s[0].enabledModels' "$2" > "$tmp"; then
    cat "$tmp" > "$2"
  else
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

# pia: the assistant pi profile (mail, calendar, reminders, messages, notes,
# timesheets). A separate agent directory, so it carries its own skills,
# persona, sessions, and memory instead of the coding profile's. Linked by
# `mise run bootstrap:pi-assistant`; falls back to plain pi if that never ran.
#
# settings.json is per-profile, but the Ctrl+P list (enabledModels) should be
# the same in both. Copy pi → pia on launch; if /scoped-models saved during
# the session, copy back on exit. A running session is unchanged.
pia() {
  if [[ ! -e ~/.pi/assistant/settings.json ]]; then
    print -u2 "pia: ~/.pi/assistant is not set up — run: mise run bootstrap:pi-assistant"
    return 1
  fi

  local agent=~/.pi/agent/settings.json
  local assistant=~/.pi/assistant/settings.json
  local before after st

  if (( $+commands[jq] )) && [[ -e $agent ]]; then
    jq -e --slurpfile s "$agent" '.enabledModels == $s[0].enabledModels' "$assistant" >/dev/null 2>&1 ||
      _pi_copy_enabled_models "$agent" "$assistant"
    before=$(jq -c '.enabledModels // []' "$assistant")
  fi

  PI_CODING_AGENT_DIR=~/.pi/assistant pi "$@"
  st=$?

  if [[ -n "$before" ]]; then
    after=$(jq -c '.enabledModels // []' "$assistant")
    [[ "$before" == "$after" ]] || _pi_copy_enabled_models "$assistant" "$agent"
  fi
  return $st
}
