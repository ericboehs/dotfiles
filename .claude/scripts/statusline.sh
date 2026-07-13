#!/bin/bash
input=$(cat)

# --- Cross-platform helpers ---
# macOS uses `stat -f%m`, Linux uses `stat -c %Y` for file mtime (epoch)
if stat -f%m /dev/null >/dev/null 2>&1; then
  file_mtime() { stat -f%m "$1"; }
else
  file_mtime() { stat -c %Y "$1"; }
fi

# macOS uses `date -j -f fmt str +%s`, Linux uses `date -d str +%s`
# Usage: parse_date "format" "datestr" -> epoch (or "0" on failure)
parse_date() {
  local fmt="$1" str="$2"
  date -j -f "$fmt" "$str" +%s 2>/dev/null || date -d "$str" +%s 2>/dev/null || echo "0"
}

# --- Configuration ---
SHOW_PACE=${SHOW_PACE:-false}  # true = pace-vs-expected labels (gated by thresholds); false = always show actual usage %
PACE_AHEAD_THRESHOLD=10    # Show warning when this many % ahead of expected pace
PACE_BEHIND_THRESHOLD=25   # Show nudge when this many % behind expected pace
USAGE_ALWAYS_SHOW=90       # Always show usage when actual % >= this value

# --- Parse input JSON ---
current_dir=$(echo "$input" | jq -r '.workspace.current_dir')
total=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
used=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
if [ -z "$used" ]; then
  pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
  used=$(echo "$total * $pct / 100" | bc)
fi
pct=$(echo "$used * 100 / $total" | bc)
model_id=$(echo "$input" | jq -r '.model.id // "unknown"')
# Keep full version info, just strip "claude-" prefix and bracket suffixes
model=$(echo "$model_id" | sed 's/\[.*\]$//; s/^claude-//')

# --- Proxy-specific context window overrides ---
if echo "$ANTHROPIC_BASE_URL" | grep -qE ':4141'; then
  # Uses context_window_size from Claude Code; set CLAUDE_CODE_AUTO_COMPACT_WINDOW in clapilot to override
  pct=$(echo "$used * 100 / $total" | bc)
elif echo "$ANTHROPIC_BASE_URL" | grep -qE ':8083'; then
  total=131000
  pct=$(echo "$used * 100 / $total" | bc)
elif echo "$ANTHROPIC_BASE_URL" | grep -qE ':8000'; then
  # Derive currently-loaded oMLX model from server log (cached 10s)
  omlx_cache="/tmp/omlx-active-cache"
  if [ -f "$omlx_cache" ] && [ "$(( $(date +%s) - $(file_mtime "$omlx_cache") ))" -lt 10 ]; then
    omlx_model=$(cat "$omlx_cache")
  else
    omlx_model=$(grep -E "(Loading|Unloading) model:" ~/.omlx/logs/server.log 2>/dev/null \
      | tail -50 \
      | sed -E 's/.*(Loading|Unloading) model: ([^ ]+).*/\1 \2/' \
      | awk '$1=="Loading"{s=$2} $1=="Unloading"&&$2==s{s=""} END{print s}')
    echo "$omlx_model" > "$omlx_cache"
  fi
  if [ -n "$omlx_model" ] && [ -f ~/.omlx/model_settings.json ]; then
    ctx=$(jq -r --arg m "$omlx_model" --slurpfile g ~/.omlx/settings.json \
      '.models[$m].max_context_window // $g[0].sampling.max_context_window // empty' \
      ~/.omlx/model_settings.json 2>/dev/null)
    [ -n "$ctx" ] && [ "$ctx" != "null" ] && total=$ctx
  fi
  pct=$(echo "$used * 100 / $total" | bc)
fi

# --- Effective context budget (auto-compaction aware) ---
# Claude Code auto-compacts at CLAUDE_AUTOCOMPACT_PCT_OVERRIDE% of the
# CLAUDE_CODE_AUTO_COMPACT_WINDOW. Base the gauge on that trigger so the %
# tracks "how close to auto-compact" instead of the raw physical window —
# otherwise a 1M-context model reads a misleadingly low % right up until it
# compacts. The env window can only shrink the denominator, never exceed the
# backend's real window (protects capped proxies like cerebras/oMLX).
if [ -n "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" ] && [ "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" -gt 0 ] 2>/dev/null; then
  [ "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" -lt "$total" ] 2>/dev/null && total="$CLAUDE_CODE_AUTO_COMPACT_WINDOW"
fi
if [ -n "$CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" ] && [ "$CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" -gt 0 ] 2>/dev/null && [ "$CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" -le 100 ] 2>/dev/null; then
  total=$(( total * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE / 100 ))
fi
pct=$(echo "$used * 100 / $total" | bc)

# --- Format token counts ---
if [ "$used" -ge 1000000 ]; then
  used_fmt="$(echo "$used/1000000" | bc)M"
elif [ "$used" -ge 1000 ]; then
  used_fmt="$(echo "scale=0; $used/1000" | bc)k"
else
  used_fmt="$used"
fi

if [ "$total" -ge 1000000 ]; then
  total_fmt="$(echo "$total/1000000" | bc)M"
else
  total_fmt="$(echo "scale=0; $total/1000" | bc)k"
fi

# --- Context percentage color ---
if [ "$pct" -ge 80 ] 2>/dev/null; then
  pct_color='\033[31m'
elif [ "$pct" -ge 50 ] 2>/dev/null; then
  pct_color='\033[33m'
else
  pct_color='\033[36m'
fi


# --- Time-aware usage projection ---
# Projects usage to end of window. Outputs: "projected_pct color_code"
# Args: usage_pct elapsed_pct (both 0-100 integers)
pace_projected() {
  local usage=$1 elapsed=$2
  local projected=$usage
  if [ "$elapsed" -gt 5 ] 2>/dev/null && [ "$usage" -gt 0 ] 2>/dev/null; then
    projected=$(( usage * 100 / elapsed ))
  fi
  local color
  if [ "$projected" -ge 100 ] 2>/dev/null; then color='\033[31m'
  elif [ "$projected" -ge 75 ] 2>/dev/null; then color='\033[33m'
  else color='\033[36m'; fi
  echo "${projected}:${color}"
}

# === Build segments (plain text for measuring, colored for display) ===
now=$(date +%s)
cols=$(tput cols 2>/dev/null || echo 80)

# --- Dir + branch ---
if [ "$current_dir" = "$HOME" ]; then
  dir_display="~"
else
  dir_display=$(basename "$current_dir")
  [ ${#dir_display} -gt 30 ] && dir_display="${dir_display:0:29}…"
fi
if [ -n "$SSH_CONNECTION" ] || [ "$container" = "container" ]; then
  host=$(hostname -s)
  # Friendly hostname aliases
  case "$host" in
    OKL-*) host="gfe" ;;
  esac
  seg_dir_plain="${host}:${dir_display}"
  seg_dir_color="\033[32m${host}\033[0m:\033[34m${dir_display}\033[0m"
else
  seg_dir_plain="$dir_display"
  seg_dir_color="\033[34m${dir_display}\033[0m"
fi

# --- Git branch + status ---
seg_git_plain=""
seg_git_color=""
if [ -d "$current_dir/.git" ]; then
  cd "$current_dir"
  git_branch=$(git branch --show-current 2>/dev/null)
  if [ -n "$git_branch" ]; then
    [ ${#git_branch} -gt 30 ] && git_branch="${git_branch:0:29}…"
    git_indicators=""
    git_status=$(git status --porcelain 2>/dev/null | head -20)
    if [ -n "$git_status" ]; then
      echo "$git_status" | grep -q '^.[MD]' && git_indicators="${git_indicators}!"
      echo "$git_status" | grep -q '^??' && git_indicators="${git_indicators}?"
      echo "$git_status" | grep -q '^[MADRC]' && git_indicators="${git_indicators}+"
    fi
    if [ -n "$git_indicators" ]; then
      seg_git_plain=" ${git_branch} [${git_indicators}]"
      seg_git_color=" \033[35m${git_branch}\033[0m \033[33m[${git_indicators}]\033[0m"
    else
      seg_git_plain=" ${git_branch}"
      seg_git_color=" \033[35m${git_branch}\033[0m"
    fi
  fi
fi

# --- Proxy ---
seg_proxy_plain=""
seg_proxy_color=""
usage_str=""
usage_str_plain=""
if echo "$ANTHROPIC_BASE_URL" | grep -qE ':4141'; then
  seg_proxy_plain=" copilot"
  seg_proxy_color=" \033[31mcopilot\033[0m"
  # Cache copilot usage to avoid hitting the API every statusline refresh
  # Cache format: usage_pct:usage_pct_int:reset_epoch
  copilot_cache="/tmp/copilot-usage-cache"
  copilot_cache_max_age=120
  if [ -f "$copilot_cache" ] && [ "$(( now - $(file_mtime "$copilot_cache") ))" -lt "$copilot_cache_max_age" ]; then
    copilot_info=$(cat "$copilot_cache")
  else
    (
      copilot_host=$(echo "$ANTHROPIC_BASE_URL" | sed 's|^http://||; s|/.*||')
      resp=$(curl -s --max-time 3 "http://${copilot_host}/usage" 2>/dev/null)
      if [ -n "$resp" ]; then
        cp_usage_pct=$(echo "$resp" | jq -r '.quota_snapshots.premium_interactions | ((.entitlement - .remaining) / .entitlement * 100 * 10 | round / 10)' 2>/dev/null)
        cp_reset_date=$(echo "$resp" | jq -r '.quota_reset_date // empty' 2>/dev/null)
        if [ -n "$cp_usage_pct" ] && [ "$cp_usage_pct" != "null" ]; then
          cp_usage_int=$(echo "$cp_usage_pct" | cut -d. -f1)
          [ -z "$cp_usage_int" ] && cp_usage_int=0
          cp_reset_epoch=0
          if [ -n "$cp_reset_date" ]; then
            cp_reset_epoch=$(parse_date "%Y-%m-%d" "$cp_reset_date")
          fi
          echo "${cp_usage_pct}:${cp_usage_int}:${cp_reset_epoch}" > "$copilot_cache"
        fi
      fi
    ) &
    [ -f "$copilot_cache" ] && copilot_info=$(cat "$copilot_cache")
  fi
  if [ -n "$copilot_info" ]; then
    usage_pct=$(echo "$copilot_info" | cut -d: -f1)
    usage_pct_int=$(echo "$copilot_info" | cut -d: -f2)
    copilot_reset_epoch=$(echo "$copilot_info" | cut -d: -f3)
    if [ "$usage_pct_int" -ge 80 ] 2>/dev/null; then uc='\033[31m'
    elif [ "$usage_pct_int" -ge 50 ] 2>/dev/null; then uc='\033[33m'
    else uc='\033[36m'; fi
    usage_str=" ${uc}${usage_pct}%%\033[0m"
    usage_str_plain=" ${usage_pct}%"
    # Monthly pace projection against reset date
    if [ "$copilot_reset_epoch" -gt 0 ] 2>/dev/null && [ "$usage_pct_int" -gt 0 ] 2>/dev/null; then
      # Determine month start (1st of current month)
      month_start_epoch=$(parse_date "%Y-%m-%d" "$(date +%Y-%m)-01")
      if [ "$month_start_epoch" -gt 0 ] 2>/dev/null; then
        month_total=$(( copilot_reset_epoch - month_start_epoch ))
        month_elapsed=$(( now - month_start_epoch ))
        [ "$month_elapsed" -lt 0 ] && month_elapsed=0
        if [ "$month_elapsed" -gt 3600 ] 2>/dev/null; then
          elapsed_pct=$(( month_elapsed * 100 / month_total ))
          ahead=$(( usage_pct_int - elapsed_pct ))
          if [ "$ahead" -ge "$PACE_AHEAD_THRESHOLD" ] 2>/dev/null || [ "$(( -ahead ))" -ge "$PACE_BEHIND_THRESHOLD" ] 2>/dev/null || [ "$usage_pct_int" -ge "$USAGE_ALWAYS_SHOW" ] 2>/dev/null; then
            if [ "$ahead" -ge 20 ] 2>/dev/null; then pc='\033[31m'
            elif [ "$ahead" -ge 10 ] 2>/dev/null; then pc='\033[33m'
            else pc='\033[36m'; fi
            if [ "$ahead" -gt 0 ] 2>/dev/null; then
              pace_label="+${ahead}%%"
              pace_label_plain="+${ahead}%"
            else
              pace_label="${ahead}%%"
              pace_label_plain="${ahead}%"
            fi
            # Add time-to-reset when usage is high
            if [ "$usage_pct_int" -ge 80 ] 2>/dev/null; then
              remaining_secs=$(( copilot_reset_epoch - now ))
              [ "$remaining_secs" -lt 0 ] && remaining_secs=0
              if [ "$remaining_secs" -lt 86400 ]; then
                reset_fmt="$((remaining_secs / 3600))h"
              else
                reset_d=$((remaining_secs / 86400))
                reset_h=$(( (remaining_secs % 86400) / 3600 ))
                if [ "$reset_h" -ge 12 ]; then reset_fmt="$(( reset_d + 1 ))d"
                else reset_fmt="${reset_d}d"; fi
              fi
              pace_label="${pace_label}↻${reset_fmt}"
              pace_label_plain="${pace_label_plain}↻${reset_fmt}"
            fi
            usage_str="${usage_str} ${pc}${pace_label}\033[0m"
            usage_str_plain="${usage_str_plain} ${pace_label_plain}"
          fi
        fi
      fi
    fi
  fi
elif proxy="${ANTHROPIC_BASE_URL:-${HTTPS_PROXY:-$HTTP_PROXY}}"; [ -n "$proxy" ]; then
  if echo "$proxy" | grep -qE ':8000'; then
    seg_proxy_plain=" oMLX"
    seg_proxy_color=" \033[31moMLX\033[0m"
  elif echo "$proxy" | grep -qE ':8083'; then
    seg_proxy_plain=" cerebras"
    seg_proxy_color=" \033[31mcerebras\033[0m"
    cache_file="/tmp/cerebras-usage-cache"
    cache_max_age=60
    if [ -f "$cache_file" ] && [ "$(( now - $(file_mtime "$cache_file") ))" -lt "$cache_max_age" ]; then
      cerebras_info=$(cat "$cache_file")
    else
      (
        CEREBRAS_API_KEY="${CEREBRAS_API_KEY:-$(op item get "cerebras.ai" --fields "label=API Key (Cerebras Code)" --reveal 2>/dev/null)}"
        if [ -n "$CEREBRAS_API_KEY" ]; then
          headers=$(curl -sS -D /dev/stdout --max-time 5 'https://api.cerebras.ai/v1/chat/completions' \
            -H "Authorization: Bearer $CEREBRAS_API_KEY" \
            -H 'Content-Type: application/json' \
            -d '{"model":"zai-glm-4.7","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
            -o /dev/null 2>/dev/null)
          req_day_rem=$(echo "$headers" | grep -i 'x-ratelimit-remaining-requests-day' | cut -d' ' -f2 | tr -d '\r')
          tok_day_rem=$(echo "$headers" | grep -i 'x-ratelimit-remaining-tokens-day' | cut -d' ' -f2 | tr -d '\r')
          if [ -n "$req_day_rem" ]; then
            req_pct=$(( (72000 - req_day_rem) * 100 / 72000 ))
            tok_pct=$(( (24000000 - tok_day_rem) * 100 / 24000000 ))
            echo "${req_pct}:${tok_pct}" > "$cache_file"
          fi
        fi
      ) &
      [ -f "$cache_file" ] && cerebras_info=$(cat "$cache_file")
    fi
    if [ -n "$cerebras_info" ]; then
      req_pct=$(echo "$cerebras_info" | cut -d: -f1)
      tok_pct=$(echo "$cerebras_info" | cut -d: -f2)
      day_elapsed=$(( (now % 86400) * 100 / 86400 ))
      req_result=$(pace_projected "$req_pct" "$day_elapsed")
      req_proj=$(echo "$req_result" | cut -d: -f1)
      rc=$(echo "$req_result" | cut -d: -f2-)
      tok_result=$(pace_projected "$tok_pct" "$day_elapsed")
      tok_proj=$(echo "$tok_result" | cut -d: -f1)
      tc=$(echo "$tok_result" | cut -d: -f2-)
      if [ "$req_proj" -ge 90 ] 2>/dev/null; then
        usage_str="${usage_str} ${rc}r:~${req_proj}%%\033[0m"
        usage_str_plain="${usage_str_plain} r:~${req_proj}%"
      fi
      if [ "$tok_proj" -ge 90 ] 2>/dev/null; then
        usage_str="${usage_str} ${tc}t:~${tok_proj}%%\033[0m"
        usage_str_plain="${usage_str_plain} t:~${tok_proj}%"
      fi
    fi
  else
    proxy_short=$(echo "$proxy" | sed 's|^https\?://||')
    seg_proxy_plain=" ${proxy_short}"
    seg_proxy_color=" \033[31m${proxy_short}\033[0m"
  fi
else
  # Direct Claude subscription — fetch 5h/7d usage with reset times
  # Cache format: five_pct:seven_pct:five_reset_epoch:seven_reset_epoch:extra_used:extra_limit
  cache_file="/tmp/claude-usage-cache"
  cache_max_age=120
  if [ -f "$cache_file" ] && [ "$(( now - $(file_mtime "$cache_file") ))" -lt "$cache_max_age" ]; then
    claude_usage=$(cat "$cache_file")
  else
    (
      token=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
      if [ -n "$token" ]; then
        resp=$(curl -s --max-time 5 'https://api.anthropic.com/api/oauth/usage' \
          -H "Authorization: Bearer $token" \
          -H "anthropic-beta: oauth-2025-04-20" \
          -H "Content-Type: application/json" 2>/dev/null)
        five=$(echo "$resp" | jq -r '.five_hour.utilization // empty' 2>/dev/null | cut -d. -f1)
        seven=$(echo "$resp" | jq -r '.seven_day.utilization // empty' 2>/dev/null | cut -d. -f1)
        five_reset=$(echo "$resp" | jq -r '.five_hour.resets_at // empty' 2>/dev/null)
        seven_reset=$(echo "$resp" | jq -r '.seven_day.resets_at // empty' 2>/dev/null)
        if [ -n "$five" ] && [ -n "$seven" ]; then
          five_epoch=$(TZ=UTC parse_date "%Y-%m-%dT%H:%M:%S" "$(echo "$five_reset" | cut -d. -f1)")
          seven_epoch=$(TZ=UTC parse_date "%Y-%m-%dT%H:%M:%S" "$(echo "$seven_reset" | cut -d. -f1)")
          extra_used=$(echo "$resp" | jq -r '.extra_usage.used_credits // 0' 2>/dev/null | cut -d. -f1)
          extra_limit=$(echo "$resp" | jq -r '.extra_usage.monthly_limit // 0' 2>/dev/null | cut -d. -f1)
          echo "${five}:${seven}:${five_epoch}:${seven_epoch}:${extra_used}:${extra_limit}" > "$cache_file"
        fi
      fi
    ) &
    [ -f "$cache_file" ] && claude_usage=$(cat "$cache_file")
  fi
  if [ -n "$claude_usage" ]; then
    five_pct=$(echo "$claude_usage" | cut -d: -f1)
    seven_pct=$(echo "$claude_usage" | cut -d: -f2)
    five_reset_epoch=$(echo "$claude_usage" | cut -d: -f3)
    seven_reset_epoch=$(echo "$claude_usage" | cut -d: -f4)
    extra_used=$(echo "$claude_usage" | cut -d: -f5)
    extra_limit=$(echo "$claude_usage" | cut -d: -f6)
    [ -z "$extra_used" ] && extra_used=0
    [ -z "$extra_limit" ] && extra_limit=0

    # Format time-to-reset as compact string (e.g. "4.5h" or "2.3d")
    fmt_reset() {
      local reset_epoch=$1
      if [ -n "$reset_epoch" ] && [ "$reset_epoch" -gt 0 ] 2>/dev/null; then
        local remaining=$(( reset_epoch - now ))
        [ "$remaining" -lt 0 ] && remaining=0
        if [ "$remaining" -lt 3600 ]; then
          echo "$((remaining / 60))m"
        elif [ "$remaining" -lt 86400 ]; then
          local h=$((remaining / 3600))
          local m=$(( (remaining % 3600) / 60 ))
          if [ "$m" -ge 45 ]; then echo "$(( h + 1 ))h"
          elif [ "$m" -ge 15 ]; then echo "${h}.5h"
          else echo "${h}h"; fi
        else
          local d=$((remaining / 86400))
          local h=$(( (remaining % 86400) / 3600 ))
          if [ "$h" -ge 12 ]; then echo "$(( d + 1 ))d"
          else echo "${d}.$(( h * 10 / 24 ))d"; fi
        fi
      fi
    }

    # How far ahead/behind expected pace for a window
    # ahead = actual_usage - expected_usage_at_this_point
    # expected = elapsed_pct = ((window_duration - remaining) / window_duration) * 100
    # Positive = ahead (burning fast), negative = behind (on track)
    # Args: usage_pct reset_epoch window_seconds
    # Output: "ahead_pct:color_code"
    claude_pace() {
      local usage=$1 reset_epoch=$2 window_secs=$3
      local ahead=0
      if [ "$reset_epoch" -gt 0 ] 2>/dev/null; then
        local remaining=$(( reset_epoch - now ))
        [ "$remaining" -lt 0 ] && remaining=0
        local elapsed=$(( window_secs - remaining ))
        [ "$elapsed" -lt 0 ] && elapsed=0
        local expected=$(( elapsed * 100 / window_secs ))
        ahead=$(( usage - expected ))
      fi
      local color
      if [ "$ahead" -ge 20 ] 2>/dev/null; then color='\033[31m'
      elif [ "$ahead" -ge 10 ] 2>/dev/null; then color='\033[33m'
      else color='\033[36m'; fi
      echo "${ahead}:${color}"
    }

    # Elapsed time into a window as "N.N" (caller appends the unit, e.g. /5H).
    # Args: reset_epoch window_secs unit_secs(3600=hours, 86400=days)
    fmt_elapsed() {
      local reset_epoch=$1 window_secs=$2 unit_secs=$3
      local remaining=$(( reset_epoch - now ))
      [ "$remaining" -lt 0 ] && remaining=0
      [ "$remaining" -gt "$window_secs" ] && remaining=$window_secs
      local elapsed=$(( window_secs - remaining ))
      local tenths=$(( elapsed * 10 / unit_secs ))
      echo "$(( tenths / 10 )).$(( tenths % 10 ))"
    }

    # Color an actual usage % (high = red). Output: color escape code
    usage_color() {
      local pct=$1
      if [ "$pct" -ge 90 ] 2>/dev/null; then echo '\033[31m'
      elif [ "$pct" -ge 75 ] 2>/dev/null; then echo '\033[33m'
      else echo '\033[36m'; fi
    }

    # --- 5h window (18000s) ---
    if [ "$five_pct" -gt 0 ] 2>/dev/null; then
      if [ "$SHOW_PACE" = true ]; then
        five_result=$(claude_pace "$five_pct" "$five_reset_epoch" 18000)
        five_ahead=$(echo "$five_result" | cut -d: -f1)
        fc=$(echo "$five_result" | cut -d: -f2-)
        five_behind=$(( -five_ahead ))
        if [ "$five_ahead" -ge "$PACE_AHEAD_THRESHOLD" ] 2>/dev/null || [ "$five_behind" -ge "$PACE_BEHIND_THRESHOLD" ] 2>/dev/null || [ "$five_pct" -ge "$USAGE_ALWAYS_SHOW" ] 2>/dev/null; then
          if [ "$five_ahead" -gt 0 ] 2>/dev/null; then
            five_label="5h: +${five_ahead}%% @ ${five_pct}%%"
            five_label_plain="5h: +${five_ahead}% @ ${five_pct}%"
          else
            five_label="5h: ${five_ahead}%%"
            five_label_plain="5h: ${five_ahead}%"
          fi
          # Add time-to-reset when usage is high
          if [ "$five_pct" -ge 80 ] 2>/dev/null; then
            five_reset_str=$(fmt_reset "$five_reset_epoch")
            if [ -n "$five_reset_str" ]; then
              five_label="${five_label}↻${five_reset_str}"
              five_label_plain="${five_label_plain}↻${five_reset_str}"
            fi
          fi
          usage_str="${usage_str} ${fc}${five_label}\033[0m"
          usage_str_plain="${usage_str_plain} ${five_label_plain}"
        fi
      else
        # Actual usage %, always shown: elapsed/window prefix, e.g. 0.5/5H: 11%
        fc=$(usage_color "$five_pct")
        five_elapsed=$(fmt_elapsed "$five_reset_epoch" 18000 3600)
        five_label="${five_elapsed}/5H: ${five_pct}%%"
        five_label_plain="${five_elapsed}/5H: ${five_pct}%"
        usage_str="${usage_str} ${fc}${five_label}\033[0m"
        usage_str_plain="${usage_str_plain} ${five_label_plain}"
      fi
    fi

    # --- 7d window (604800s) ---
    if [ "$seven_pct" -gt 0 ] 2>/dev/null; then
      if [ "$SHOW_PACE" = true ]; then
        seven_result=$(claude_pace "$seven_pct" "$seven_reset_epoch" 604800)
        seven_ahead=$(echo "$seven_result" | cut -d: -f1)
        sc=$(echo "$seven_result" | cut -d: -f2-)
        seven_behind=$(( -seven_ahead ))
        if [ "$seven_ahead" -ge "$PACE_AHEAD_THRESHOLD" ] 2>/dev/null || [ "$seven_behind" -ge "$PACE_BEHIND_THRESHOLD" ] 2>/dev/null || [ "$seven_pct" -ge "$USAGE_ALWAYS_SHOW" ] 2>/dev/null; then
          if [ "$seven_ahead" -gt 0 ] 2>/dev/null; then
            seven_label="7d: +${seven_ahead}%% @ ${seven_pct}%%"
            seven_label_plain="7d: +${seven_ahead}% @ ${seven_pct}%"
          else
            seven_label="7d: ${seven_ahead}%%"
            seven_label_plain="7d: ${seven_ahead}%"
          fi
          if [ "$seven_pct" -ge 80 ] 2>/dev/null; then
            seven_reset_str=$(fmt_reset "$seven_reset_epoch")
            if [ -n "$seven_reset_str" ]; then
              seven_label="${seven_label}↻${seven_reset_str}"
              seven_label_plain="${seven_label_plain}↻${seven_reset_str}"
            fi
          fi
          usage_str="${usage_str} ${sc}${seven_label}\033[0m"
          usage_str_plain="${usage_str_plain} ${seven_label_plain}"
        fi
      else
        # Actual usage %, always shown: elapsed/window prefix, e.g. 2.5/7D: 18%
        sc=$(usage_color "$seven_pct")
        seven_elapsed=$(fmt_elapsed "$seven_reset_epoch" 604800 86400)
        seven_label="${seven_elapsed}/7D: ${seven_pct}%%"
        seven_label_plain="${seven_elapsed}/7D: ${seven_pct}%"
        usage_str="${usage_str} ${sc}${seven_label}\033[0m"
        usage_str_plain="${usage_str_plain} ${seven_label_plain}"
      fi
    fi

    # --- Extra usage (overuse billing) — only show when 5h is at 100% ---
    if [ "$five_pct" -ge 100 ] 2>/dev/null && [ "$extra_limit" -gt 0 ] 2>/dev/null; then
      if [ "$extra_used" -ge 100 ]; then
        extra_used_fmt="\$$(( extra_used / 100 ))"
      else
        extra_used_fmt="\$0"
      fi
      extra_limit_fmt="\$$(( extra_limit / 100 ))"
      extra_pct=$(( extra_used * 100 / extra_limit ))
      if [ "$extra_pct" -ge 80 ] 2>/dev/null; then ec='\033[31m'
      elif [ "$extra_pct" -ge 50 ] 2>/dev/null; then ec='\033[33m'
      else ec='\033[36m'; fi
      usage_str="${usage_str} ${ec}${extra_used_fmt}/${extra_limit_fmt}\033[0m"
      usage_str_plain="${usage_str_plain} ${extra_used_fmt}/${extra_limit_fmt}"
    fi
  fi
fi

# --- Model + context ---
seg_model_plain=" ${model}"
seg_model_color=" \033[33m${model}\033[0m"
seg_ctx_plain=" ${used_fmt}/${total_fmt}"
seg_ctx_color=" ${pct_color}${used_fmt}/${total_fmt}\033[0m"

# === Measure and output (wrap to second line if needed) ===
line1_plain="${seg_dir_plain}${seg_git_plain}${seg_proxy_plain}${seg_model_plain}${seg_ctx_plain}${usage_str_plain}"

if [ ${#line1_plain} -le "$cols" ]; then
  # Fits on one line
  printf "${seg_dir_color}${seg_git_color}${seg_proxy_color}${seg_model_color}${seg_ctx_color}${usage_str}"
else
  # Split: dir+branch on line 1, rest on line 2
  printf "${seg_dir_color}${seg_git_color}"
  printf "\n"
  # Remove leading space from first segment on line 2
  l2_proxy="${seg_proxy_color# }"
  l2_model="${seg_model_color}"
  if [ -z "$seg_proxy_plain" ]; then
    l2_model="${seg_model_color# }"
  fi
  printf "${l2_proxy}${l2_model}${seg_ctx_color}${usage_str}"
fi
