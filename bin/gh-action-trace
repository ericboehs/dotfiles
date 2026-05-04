#!/usr/bin/env bash
#
# gh-action-trace — Find all direct and transitive uses of GitHub Actions in an org.
#
# Traces the full dependency chain: repos that directly reference target actions,
# repos that call shared/reusable workflows containing those actions, and external
# shared workflows that wrap them. Reports pinning status (SHA/tag/branch) for each.
#
# Requires: gh (GitHub CLI), jq, base64
#
# Usage:
#   gh-action-trace --org department-of-veterans-affairs --action aquasecurity/trivy-action
#   gh-action-trace --org my-org --action actions/checkout --action actions/setup-node
#   gh-action-trace --org my-org --action aquasecurity/trivy-action --depth 3 --format json
#
# Options:
#   --org ORG           GitHub org to search (required)
#   --action ACTION     Action to trace — repeatable (required, at least one)
#   --depth N           Max recursion depth for shared workflows (default: 2)
#   --format FORMAT     Output format: text, json, both (default: both)
#   --external          Also search all of GitHub for external shared workflows (slower)
#   --output FILE       Write JSON output to file (default: stdout)
#   --check-runs FROM..TO  Check workflow run history during a time window (ISO 8601)
#                          e.g. --check-runs 2026-03-19T19:00:00Z..2026-03-21T00:00:00Z
#                          Omit TO to default to now: --check-runs 2026-03-19T19:00:00Z..
#   --quiet             Suppress progress output (only show results)
#   --verbose           Show detailed debug info
#   --help              Show this help

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

declare -a TARGET_ACTIONS=()
ORG=""
MAX_DEPTH=2
FORMAT="both"
SEARCH_EXTERNAL=false
OUTPUT_FILE=""
CHECK_RUNS=""
CHECK_RUNS_FROM=""
CHECK_RUNS_TO=""
QUIET=false
VERBOSE=false

# Rate limiting — modeled after github-viewer's approach
# Note: code_search resource has a 10/min limit (not 30 like regular search)
# These are stored as files (in COUNTER_DIR) to survive subshell boundaries.
SEARCH_CRITICAL_THRESHOLD=2
SEARCH_WARNING_THRESHOLD=4

# Retry config (exponential backoff for server errors)
MAX_RETRIES=3
RETRY_BACKOFF_BASE=2

# Counter/state directory — set in main(), all mutable state lives here
COUNTER_DIR=""

# Results accumulator (newline-delimited JSON objects)
RESULTS_FILE=""
CACHE_DIR=""

# Visited sets (prevent infinite loops and redundant work)
VISITED_WORKFLOWS_FILE=""
VISITED_SEARCHES_FILE=""

# =============================================================================
# Utility functions
# =============================================================================

log() { if [[ "$VERBOSE" == true ]]; then printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; fi; }
progress() { if [[ "$QUIET" != true ]]; then printf '%s\n' "$*" >&2; fi; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

# Inline progress bar that overwrites the current line.
# Args: $1 = current, $2 = total, $3 = found count, $4 = label
progress_bar() {
  [[ "$QUIET" == true ]] && return
  local current="$1" total="$2" found="$3" label="$4"
  local width=20 pct=0
  if [[ "$total" -gt 0 ]]; then
    pct=$(( current * 100 / total ))
  fi
  local filled=$(( pct * width / 100 ))
  local empty=$(( width - filled ))
  local bar
  bar="$(printf '%*s' "$filled" '' | tr ' ' '█')$(printf '%*s' "$empty" '' | tr ' ' '░')"
  printf '\r\033[K        %s [%d/%d] %s %d found' "$label" "$current" "$total" "$bar" "$found" >&2
  if [[ "$current" -ge "$total" ]]; then
    printf '\n' >&2
  fi
}

# Show a rate limit wait message on the progress line.
progress_wait() {
  [[ "$QUIET" == true ]] && return
  local secs="$1"
  printf '\r\033[K        Rate limited. Waiting %ds for reset...' "$secs" >&2
}

usage() {
  sed -n '/^# Usage:/,/^[^#]/{ /^[^#]/d; s/^# \?//; p; }' "$0"
  exit 0
}

# Hide cursor on start, restore on exit/Ctrl-C.
show_cursor() {
  tput cnorm 2>/dev/null || true
}

hide_cursor() {
  tput civis 2>/dev/null || true
}

cleanup() {
  show_cursor
  if [[ -n "$CACHE_DIR" && -d "$CACHE_DIR" ]]; then
    rm -rf "$CACHE_DIR"
    log "Cleaned up cache dir: $CACHE_DIR"
  fi
}
trap cleanup EXIT INT TERM

# File-based counters to survive subshell boundaries (pipe | while read).
# Each counter is a file containing a number; increment atomically.
counter_init() {
  local name="$1"
  echo "0" > "${COUNTER_DIR}/${name}"
}

counter_inc() {
  local name="$1"
  local file="${COUNTER_DIR}/${name}"
  local val
  val=$(<"$file")
  echo $(( val + 1 )) > "$file"
}

counter_dec() {
  local name="$1"
  local file="${COUNTER_DIR}/${name}"
  local val
  val=$(<"$file")
  echo $(( val - 1 )) > "$file"
}

counter_get() {
  local name="$1"
  cat "${COUNTER_DIR}/${name}"
}

counter_set() {
  local name="$1" val="$2"
  echo "$val" > "${COUNTER_DIR}/${name}"
}

# =============================================================================
# Argument parsing
# =============================================================================

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --org) ORG="$2"; shift 2 ;;
      --action) TARGET_ACTIONS+=("$2"); shift 2 ;;
      --depth) MAX_DEPTH="$2"; shift 2 ;;
      --format) FORMAT="$2"; shift 2 ;;
      --external) SEARCH_EXTERNAL=true; shift ;;
      --output) OUTPUT_FILE="$2"; shift 2 ;;
      --check-runs)
        CHECK_RUNS="$2"
        CHECK_RUNS_FROM="${2%%\.\.*}"
        CHECK_RUNS_TO="${2##*\.\.}"
        if [[ -z "$CHECK_RUNS_TO" ]]; then
          CHECK_RUNS_TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        fi
        shift 2 ;;
      --quiet|-q) QUIET=true; shift ;;
      --verbose) VERBOSE=true; shift ;;
      --help|-h) usage ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -n "$ORG" ]] || die "Missing required --org"
  [[ ${#TARGET_ACTIONS[@]} -gt 0 ]] || die "Missing required --action (at least one)"
  [[ "$FORMAT" =~ ^(text|json|both)$ ]] || die "Invalid --format: $FORMAT (must be text, json, or both)"
  [[ "$MAX_DEPTH" =~ ^[0-9]+$ ]] || die "Invalid --depth: $MAX_DEPTH (must be a number)"
}

# =============================================================================
# Rate limiting
# =============================================================================

# Refresh rate limit info from the API (costs 1 core API call).
refresh_rate_limit() {
  local info
  info=$(gh api '/rate_limit' 2>/dev/null) || return 1
  counter_inc core_calls

  local search_info
  search_info=$(echo "$info" | jq '.resources.code_search // .resources.search // empty')

  if [[ -n "$search_info" ]]; then
    local remaining limit reset
    remaining=$(echo "$search_info" | jq -r '.remaining')
    limit=$(echo "$search_info" | jq -r '.limit')
    reset=$(echo "$search_info" | jq -r '.reset')
    counter_set search_remaining "$remaining"
    counter_set search_limit "$limit"
    counter_set search_reset "$reset"
    log "Rate limit refreshed: search ${remaining}/${limit} (resets $(date -r "${reset}" +%H:%M:%S 2>/dev/null || echo "at ${reset}"))"
  fi

  local core_info
  core_info=$(echo "$info" | jq '.resources.core // empty')
  if [[ -n "$core_info" ]]; then
    counter_set core_remaining "$(echo "$core_info" | jq -r '.remaining')"
  fi
}

# Pre-emptively wait if we're approaching the search rate limit.
throttle_search() {
  local search_calls remaining limit reset

  search_calls=$(counter_get search_calls)
  # Refresh from API every 3 search calls to stay accurate
  if (( search_calls % 3 == 0 && search_calls > 0 )); then
    refresh_rate_limit
  fi

  remaining=$(counter_get search_remaining)
  limit=$(counter_get search_limit)
  reset=$(counter_get search_reset)

  if [[ "$remaining" -le "$SEARCH_CRITICAL_THRESHOLD" ]]; then
    refresh_rate_limit
    remaining=$(counter_get search_remaining)
    reset=$(counter_get search_reset)

    if [[ "$remaining" -le "$SEARCH_CRITICAL_THRESHOLD" && "$reset" -gt 0 ]]; then
      local now wait_secs
      now=$(date +%s)
      wait_secs=$(( reset - now + 1 ))

      if [[ "$wait_secs" -gt 0 && "$wait_secs" -le 120 ]]; then
        progress_wait "$wait_secs"
        sleep "$wait_secs"
        counter_set search_remaining "$limit"
      fi
    fi
  elif [[ "$remaining" -le "$SEARCH_WARNING_THRESHOLD" ]]; then
    log "Search rate limit getting low (${remaining}/${limit} remaining). Adding 3s delay."
    sleep 3
  fi
}

# =============================================================================
# GitHub API wrappers
# =============================================================================

# Make a GitHub API call with rate limit tracking and retry logic.
# Args: $1 = resource type (search|core), remaining args passed to gh api
# Outputs: response body on stdout
gh_api() {
  local resource="$1"; shift
  local retries=0
  local exit_code

  if [[ "$resource" == "search" ]]; then
    throttle_search
  fi

  local header_file="${CACHE_DIR}/last_headers.txt"

  while true; do
    local body
    # gh api outputs JSON body to stdout, errors to stderr
    body=$(gh api "$@" 2>"${header_file}.err") && exit_code=0 || exit_code=$?

    if [[ $exit_code -eq 0 ]]; then
      case "$resource" in
        search)
          counter_inc search_calls
          counter_dec search_remaining
          log "Search calls: $(counter_get search_calls) (est. remaining: $(counter_get search_remaining))"
          ;;
        core)
          counter_inc core_calls
          counter_dec core_remaining
          ;;
      esac

      echo "$body"
      return 0
    fi

    local err_msg
    err_msg=$(cat "${header_file}.err" 2>/dev/null || echo "unknown error")

    # Check for rate limit error
    if echo "$err_msg" | grep -qi "rate limit\|API rate limit\|secondary rate limit\|abuse detection"; then
      # Try to get actual rate limit reset time
      local rate_info
      rate_info=$(gh api '/rate_limit' --jq ".resources.code_search // .resources.search // .resources.core" 2>/dev/null || true)

      if [[ -n "$rate_info" ]]; then
        local reset_at remaining
        reset_at=$(echo "$rate_info" | jq -r '.reset // 0')
        remaining=$(echo "$rate_info" | jq -r '.remaining // 0')
        counter_set search_remaining "$remaining"
        counter_set search_reset "$reset_at"

        local now wait_secs
        now=$(date +%s)
        wait_secs=$(( reset_at - now + 1 ))

        if [[ "$wait_secs" -gt 0 && "$wait_secs" -le 120 ]]; then
          progress_wait "$wait_secs"
          sleep "$wait_secs"
          counter_set search_remaining "$(counter_get search_limit)"
          continue
        fi
      fi

      progress_wait 60
      sleep 60
      continue
    fi

    # Check for server error (5xx) — retry with exponential backoff
    if echo "$err_msg" | grep -qE "50[0-9]|502|503"; then
      if [[ $retries -lt $MAX_RETRIES ]]; then
        retries=$((retries + 1))
        local delay=$(( RETRY_BACKOFF_BASE ** retries ))
        warn "Server error. Retrying in ${delay}s (attempt ${retries}/${MAX_RETRIES})"
        sleep "$delay"
        continue
      fi
    fi

    # Unrecoverable error
    warn "API call failed: $err_msg"
    return 1
  done
}

# Search code with pagination. Returns all items as a JSON array.
# Args: $1 = query string
search_code() {
  local query="$1"
  local all_items="[]"
  local page=1
  local per_page=100

  log "Searching: $query"

  while true; do
    local result
    result=$(gh_api search -X GET '/search/code' \
      -f q="$query" \
      -F per_page="$per_page" \
      -F page="$page" 2>/dev/null) || break

    local total_count items_count
    total_count=$(echo "$result" | jq -r '.total_count // 0')
    items_count=$(echo "$result" | jq -r '.items | length')

    if [[ "$items_count" -eq 0 ]]; then
      break
    fi

    # Merge items
    all_items=$(echo "$all_items" "$result" | jq -s '.[0] + (.[1].items // [])')

    local accumulated
    accumulated=$(echo "$all_items" | jq 'length')
    log "  Page $page: got $items_count items (${accumulated}/${total_count} total)"

    # Check if we've got everything or hit the 1000-result cap
    if [[ "$accumulated" -ge "$total_count" || "$accumulated" -ge 1000 ]]; then
      if [[ "$total_count" -gt 1000 ]]; then
        warn "Search returned ${total_count} results but GitHub caps at 1000. Results may be incomplete."
      fi
      break
    fi

    page=$((page + 1))
  done

  echo "$all_items"
}

# Fetch a file's content from a repo. Uses cache.
# Args: $1 = owner/repo, $2 = file path
# Outputs: decoded file content on stdout
fetch_content() {
  local repo="$1" path="$2"
  local cache_key
  cache_key=$(echo "${repo}/${path}" | tr '/' '_' | tr '.' '_')
  local cache_file="${CACHE_DIR}/content_${cache_key}"

  if [[ -f "$cache_file" ]]; then
    counter_inc cache_hits
    cat "$cache_file"
    return 0
  fi

  local result
  result=$(gh_api core -X GET "/repos/${repo}/contents/${path}" \
    --jq '.content // empty' 2>/dev/null) || return 1

  if [[ -z "$result" ]]; then
    return 1
  fi

  local decoded
  decoded=$(echo "$result" | base64 -d 2>/dev/null) || return 1
  echo "$decoded" > "$cache_file"
  echo "$decoded"
}

# =============================================================================
# Analysis functions
# =============================================================================

# Extract all `uses:` references from workflow content.
# Outputs: one JSON object per line: {"ref": "owner/repo/path@version", "raw": "original line"}
extract_uses_refs() {
  local content="$1"

  echo "$content" | grep -E '^[[:space:]]+uses:[[:space:]]' | while IFS= read -r line; do
    local ref
    ref=$(echo "$line" | sed -E 's/.*uses:[[:space:]]*"?([^"[:space:]#]+)"?.*/\1/' | xargs)

    # Skip local references (./path)
    if [[ "$ref" == ./* || "$ref" == ../* ]]; then
      continue
    fi

    # Skip Docker references
    if [[ "$ref" == docker://* ]]; then
      continue
    fi

    echo "$ref"
  done
}

# Classify a version reference as sha, tag, or branch.
# Args: $1 = full uses reference (e.g., "actions/checkout@v4" or "org/repo@abc123...")
# Outputs: JSON object with classification
classify_pin() {
  local ref="$1"
  local action_part="${ref%%@*}"
  local version="${ref#*@}"
  [[ "$ref" != *@* ]] && version=""

  local pin_type pin_risk
  if [[ -z "$version" ]]; then
    pin_type="none"; pin_risk="critical"
  elif [[ "$version" =~ ^[0-9a-f]{40}$ ]]; then
    pin_type="sha"; pin_risk="safe"
  elif [[ "$version" =~ ^v?[0-9] ]]; then
    pin_type="tag"; pin_risk="risky"
  else
    pin_type="branch"; pin_risk="dangerous"
  fi

  jq -n \
    --arg action "$action_part" \
    --arg version "$version" \
    --arg pin_type "$pin_type" \
    --arg pin_risk "$pin_risk" \
    '{action: $action, version: $version, pin_type: $pin_type, pin_risk: $pin_risk}'
}

# Check if workflow content defines a reusable workflow (has workflow_call trigger).
# Args: $1 = workflow content
# Returns: 0 if reusable, 1 if not
is_reusable_workflow() {
  local content="$1"
  echo "$content" | grep -qE '^[[:space:]]*workflow_call[[:space:]]*:?[[:space:]]*$|on:.*workflow_call|"workflow_call"'
}

# =============================================================================
# Result recording
# =============================================================================

# Add a result to the results file.
# Args: JSON object on stdin or as $1
add_result() {
  local json="${1:-$(cat)}"
  echo "$json" >> "$RESULTS_FILE"
  counter_inc found
}

# Check if a workflow has already been visited (prevent loops).
# Args: $1 = identifier (e.g., "org/repo/.github/workflows/file.yml")
# Returns: 0 if already visited, 1 if new
is_visited() {
  local id="$1"
  grep -qxF "$id" "$VISITED_WORKFLOWS_FILE" 2>/dev/null
}

mark_visited() {
  local id="$1"
  echo "$id" >> "$VISITED_WORKFLOWS_FILE"
}

is_search_done() {
  local id="$1"
  grep -qxF "$id" "$VISITED_SEARCHES_FILE" 2>/dev/null
}

mark_search_done() {
  local id="$1"
  echo "$id" >> "$VISITED_SEARCHES_FILE"
}

# =============================================================================
# Core trace logic
# =============================================================================

# Trace a single action through the org, finding direct and transitive references.
# Args: $1 = action (e.g., "aquasecurity/trivy-action")
trace_action() {
  local action="$1"
  log "=== Tracing action: $action ==="

  local total_phases=2 phase=1
  [[ "$SEARCH_EXTERNAL" == true ]] && total_phases=3

  progress "  [${phase}/${total_phases}] Searching $ORG for direct references..."
  find_direct_refs "$action"

  if [[ "$SEARCH_EXTERNAL" == true ]]; then
    phase=$((phase + 1))
    progress "  [${phase}/${total_phases}] Searching all of GitHub for external shared workflows..."
    find_external_wrappers "$action"
  fi

  phase=$((phase + 1))
  progress "  [${phase}/${total_phases}] Tracing transitive references through shared workflows..."
  trace_shared_workflows "$action" 1
}

# Find direct references to an action in the org's workflow files.
# Args: $1 = action name
find_direct_refs() {
  local action="$1"
  local search_key="direct:${ORG}:${action}"

  if is_search_done "$search_key"; then
    log "  Skipping duplicate search: $search_key"
    return
  fi
  mark_search_done "$search_key"

  local items
  items=$(search_code "${action} path:.github/workflows user:${ORG} language:yaml")

  local count
  count=$(echo "$items" | jq 'length')
  progress "        Found $count workflow files to inspect"

  if [[ "$count" -eq 0 ]]; then
    return
  fi

  # Process each result — fetch content and analyze
  local item_idx=0
  echo "$items" | jq -c '.[]' | while IFS= read -r item; do
    local repo path
    repo=$(echo "$item" | jq -r '.repository.full_name')
    path=$(echo "$item" | jq -r '.path')
    item_idx=$((item_idx + 1))

    local workflow_id="${repo}/${path}"
    if is_visited "$workflow_id"; then
      log "    Skipping already-visited: $workflow_id"
      progress_bar "$item_idx" "$count" "$(counter_get found)" "Inspecting..."
      continue
    fi
    mark_visited "$workflow_id"

    progress_bar "$item_idx" "$count" "$(counter_get found)" "Inspecting..."
    log "  Fetching: ${repo}/${path}"
    local content
    content=$(fetch_content "$repo" "$path" 2>/dev/null) || {
      warn "    Could not fetch ${repo}/${path} — skipping"
      continue
    }

    # Find all uses: lines that match our target action
    local refs
    refs=$(extract_uses_refs "$content" | grep -F "${action}" || true)

    if [[ -z "$refs" ]]; then
      # The search matched but no uses: line contains the action directly.
      # Could be a comment match or partial match — skip.
      log "    No matching uses: reference found in $workflow_id (possible false positive)"
      continue
    fi

    # Check if this workflow is itself reusable
    local reusable=false
    if is_reusable_workflow "$content"; then
      reusable=true
    fi

    # Record each matching reference
    while IFS= read -r ref; do
      local pin_info
      pin_info=$(classify_pin "$ref")

      add_result "$(jq -n \
        --arg repo "$repo" \
        --arg workflow "$path" \
        --arg ref "$ref" \
        --arg action "$action" \
        --arg ref_type "direct" \
        --argjson reusable "$reusable" \
        --argjson pin "$pin_info" \
        --arg chain "$action" \
        '{
          repo: $repo,
          workflow: $workflow,
          uses_ref: $ref,
          target_action: $action,
          reference_type: $ref_type,
          is_reusable_workflow: $reusable,
          pin_type: $pin.pin_type,
          pin_value: $pin.version,
          pin_risk: $pin.pin_risk,
          chain: [$chain]
        }')"
    done <<< "$refs"
  done
}

# Search all of GitHub for external shared workflows that wrap the target action.
# Then search the org for repos calling those external workflows.
# Args: $1 = action name
find_external_wrappers() {
  local action="$1"
  local search_key="external:${action}"

  if is_search_done "$search_key"; then
    return
  fi
  mark_search_done "$search_key"

  log "  Searching all of GitHub for workflows wrapping: $action"
  local items
  items=$(search_code "${action} path:.github/workflows language:yaml")

  local count
  count=$(echo "$items" | jq 'length')
  log "  Found $count global references"

  if [[ "$count" -eq 0 ]]; then
    return
  fi

  # Find repos outside our org that contain the action in workflow files
  local external_repos
  external_repos=$(echo "$items" | jq -r --arg org "$ORG" \
    '[.[] | select(.repository.full_name | startswith($org + "/") | not)] | unique_by(.repository.full_name) | .[].repository.full_name' 2>/dev/null || true)

  if [[ -z "$external_repos" ]]; then
    log "  No external repos found"
    return
  fi

  local ext_count
  ext_count=$(echo "$external_repos" | wc -l | tr -d ' ')
  progress "        Found $ext_count external repos wrapping $action"

  # For each external repo, check if it has reusable workflows and if our org calls them
  while IFS= read -r ext_repo; do
    [[ -z "$ext_repo" ]] && continue

    # Get the workflow files from this external repo that matched
    local ext_paths
    ext_paths=$(echo "$items" | jq -r --arg repo "$ext_repo" \
      '.[] | select(.repository.full_name == $repo) | .path')

    while IFS= read -r ext_path; do
      [[ -z "$ext_path" ]] && continue

      # Fetch and check if it's a reusable workflow
      local content
      content=$(fetch_content "$ext_repo" "$ext_path" 2>/dev/null) || continue

      if ! is_reusable_workflow "$content"; then
        continue
      fi

      log "  External reusable workflow found: ${ext_repo}/${ext_path}"

      # Search our org for callers of this external workflow
      local caller_ref="${ext_repo}/${ext_path}"
      find_callers_of_workflow "$caller_ref" "$action" 1 "$action"
    done <<< "$ext_paths"
  done <<< "$external_repos"
}

# Recursively find repos that call shared workflows containing the target action.
# Args: $1 = action being traced
#       $2 = current depth
trace_shared_workflows() {
  local action="$1"
  local depth="$2"

  if [[ "$depth" -gt "$MAX_DEPTH" ]]; then
    log "  Max depth ($MAX_DEPTH) reached — stopping recursion"
    return
  fi

  # Find all reusable workflows in our results that directly reference this action
  local reusable_workflows=""
  if [[ -s "$RESULTS_FILE" ]]; then
    reusable_workflows=$(jq -r --arg action "$action" \
      'select(.target_action == $action and .is_reusable_workflow == true and .reference_type == "direct") | "\(.repo)/\(.workflow)"' \
      "$RESULTS_FILE" 2>/dev/null | sort -u || true)
  fi

  if [[ -z "$reusable_workflows" ]]; then
    log "  No reusable workflows found at depth $depth"
    return
  fi

  local rw_total rw_idx=0
  rw_total=$(echo "$reusable_workflows" | wc -l | tr -d ' ')
  progress "        Found $rw_total reusable workflows to trace"

  while IFS= read -r workflow_path; do
    [[ -z "$workflow_path" ]] && continue
    rw_idx=$((rw_idx + 1))
    progress_bar "$rw_idx" "$rw_total" "$(counter_get found)" "Tracing callers..."
    find_callers_of_workflow "$workflow_path" "$action" "$depth" "$action"
  done <<< "$reusable_workflows"
}

# Find all repos in the org that call a given reusable workflow.
# Args: $1 = workflow ref (e.g., "org/repo/.github/workflows/file.yml")
#       $2 = original target action
#       $3 = current depth
#       $4 = chain so far (comma-separated)
find_callers_of_workflow() {
  local workflow_ref="$1"
  local target_action="$2"
  local depth="$3"
  local chain_base="$4"

  local search_key="callers:${ORG}:${workflow_ref}"
  if is_search_done "$search_key"; then
    log "    Skipping duplicate caller search: $workflow_ref"
    return
  fi
  mark_search_done "$search_key"

  # Build search query — search for the workflow reference in our org
  # Use the most specific part that's unique enough
  local search_term="$workflow_ref"
  log "  Searching ${ORG} for callers of: $workflow_ref"

  local items
  items=$(search_code "${search_term} path:.github/workflows user:${ORG} language:yaml")

  local count
  count=$(echo "$items" | jq 'length')
  log "  Found $count potential callers"

  if [[ "$count" -eq 0 ]]; then
    return
  fi

  echo "$items" | jq -c '.[]' | while IFS= read -r item; do
    local repo path
    repo=$(echo "$item" | jq -r '.repository.full_name')
    path=$(echo "$item" | jq -r '.path')

    local caller_id="${repo}/${path}->$(echo "$workflow_ref" | md5sum | cut -c1-8 2>/dev/null || md5 -q -s "$workflow_ref" 2>/dev/null || echo "$workflow_ref")"
    if is_visited "$caller_id"; then
      continue
    fi
    mark_visited "$caller_id"

    log "    Fetching caller: ${repo}/${path}"
    local content
    content=$(fetch_content "$repo" "$path" 2>/dev/null) || {
      warn "    Could not fetch ${repo}/${path} — skipping"
      continue
    }

    # Verify this workflow actually calls the target shared workflow
    local matching_refs
    matching_refs=$(extract_uses_refs "$content" | grep -F "$(basename "${workflow_ref%%@*}" .yml)" || true)

    if [[ -z "$matching_refs" ]]; then
      log "    No matching workflow_call reference found in ${repo}/${path} (false positive)"
      continue
    fi

    # Check if this caller is itself a reusable workflow
    local reusable=false
    if is_reusable_workflow "$content"; then
      reusable=true
    fi

    while IFS= read -r ref; do
      local pin_info
      pin_info=$(classify_pin "$ref")

      local chain_array
      chain_array=$(jq -n --arg wf "$workflow_ref" --arg action "$target_action" '[$wf, $action]')

      add_result "$(jq -n \
        --arg repo "$repo" \
        --arg workflow "$path" \
        --arg ref "$ref" \
        --arg action "$target_action" \
        --arg ref_type "indirect" \
        --argjson reusable "$reusable" \
        --argjson pin "$pin_info" \
        --argjson chain "$chain_array" \
        --arg via "$workflow_ref" \
        '{
          repo: $repo,
          workflow: $workflow,
          uses_ref: $ref,
          target_action: $action,
          reference_type: $ref_type,
          is_reusable_workflow: $reusable,
          pin_type: $pin.pin_type,
          pin_value: $pin.version,
          pin_risk: $pin.pin_risk,
          chain: $chain,
          via_workflow: $via
        }')"
    done <<< "$matching_refs"

    # If this caller is also a reusable workflow, recurse
    if [[ "$reusable" == true && "$depth" -lt "$MAX_DEPTH" ]]; then
      local next_ref="${repo}/${path}"
      log "    Recursing into reusable caller: $next_ref (depth $((depth + 1)))"
      find_callers_of_workflow "$next_ref" "$target_action" $((depth + 1)) "${chain_base},${workflow_ref}"
    fi
  done
}

# =============================================================================
# Leaf pin enrichment
# =============================================================================

# For indirect references, resolve the leaf action's actual pin status.
# An indirect ref like vets-api -> vsp-github-actions/sbom.yml@main -> trivy-action@0.35.0
# should report the leaf pin (tag 0.35.0) not the caller's pin (branch main).
enrich_leaf_pins() {
  [[ ! -s "$RESULTS_FILE" ]] && return

  progress "Resolving leaf pin status for indirect references..."

  local enriched_file="${CACHE_DIR}/results_leaf.jsonl"

  # Build a lookup of direct results: keyed by "repo/workflow"
  # These contain the actual trivy-action pin
  local direct_lookup
  direct_lookup=$(jq -s '
    [.[] | select(.reference_type == "direct")]
    | group_by("\(.repo)/\(.workflow)")
    | map({key: "\(.[0].repo)/\(.[0].workflow)", value: .[0]})
    | from_entries
  ' "$RESULTS_FILE")

  # Enrich each indirect result with leaf pin from its via_workflow
  jq -c --argjson lookup "$direct_lookup" '
    if .reference_type == "indirect" and .via_workflow then
      ($lookup[.via_workflow] // null) as $leaf |
      if $leaf then
        . + {
          leaf_pin_type: $leaf.pin_type,
          leaf_pin_value: $leaf.pin_value,
          leaf_pin_risk: $leaf.pin_risk,
          leaf_uses_ref: $leaf.uses_ref
        }
      else . end
    else
      # Direct refs: the pin IS the leaf pin
      . + {
        leaf_pin_type: .pin_type,
        leaf_pin_value: .pin_value,
        leaf_pin_risk: .pin_risk,
        leaf_uses_ref: .uses_ref
      }
    end
  ' "$RESULTS_FILE" > "$enriched_file"

  mv "$enriched_file" "$RESULTS_FILE"
}

# =============================================================================
# Workflow run checking
# =============================================================================

# Check if at-risk workflows ran during the specified time window.
# Enriches RESULTS_FILE entries with run_count and ran_during_window fields.
check_workflow_runs() {
  [[ -z "$CHECK_RUNS_FROM" ]] && return

  progress "Checking workflow runs during ${CHECK_RUNS_FROM}..${CHECK_RUNS_TO}..."

  # Get unique repo+workflow pairs that are at risk (leaf pin is not SHA)
  local at_risk
  at_risk=$(jq -r 'select(.leaf_pin_type != "sha" and .leaf_pin_type != null) | "\(.repo)\t\(.workflow)"' "$RESULTS_FILE" | sort -u)

  if [[ -z "$at_risk" ]]; then
    progress "        No at-risk workflows to check"
    return
  fi

  local total pair_idx=0 hits=0
  total=$(echo "$at_risk" | wc -l | tr -d ' ')

  # Create enriched results file
  local enriched_file="${CACHE_DIR}/results_enriched.jsonl"
  cp "$RESULTS_FILE" "$enriched_file"

  while IFS=$'\t' read -r repo workflow; do
    [[ -z "$repo" ]] && continue
    pair_idx=$((pair_idx + 1))
    progress_bar "$pair_idx" "$total" "$hits" "Checking runs..."

    local wf_name
    wf_name=$(basename "$workflow")

    local run_count
    run_count=$(gh api "repos/${repo}/actions/workflows/${wf_name}/runs?created=${CHECK_RUNS_FROM}..${CHECK_RUNS_TO}&per_page=1" \
      --jq '.total_count // 0' 2>/dev/null) || run_count=0
    # Ensure it's a number
    if ! [[ "$run_count" =~ ^[0-9]+$ ]]; then
      run_count=0
    fi
    counter_inc core_calls

    if [[ "$run_count" -gt 0 ]]; then
      hits=$((hits + 1))
    fi

    # Update matching entries in the enriched file with run data
    local tmp_file="${CACHE_DIR}/results_tmp.jsonl"
    jq --arg repo "$repo" --arg wf "$workflow" --argjson count "${run_count:-0}" '
      if .repo == $repo and .workflow == $wf then
        . + {run_count: $count, ran_during_window: ($count > 0)}
      else . end
    ' "$enriched_file" > "$tmp_file"
    mv "$tmp_file" "$enriched_file"
  done <<< "$at_risk"

  # Also mark SHA-pinned entries as safe (no runs to check)
  local tmp_file="${CACHE_DIR}/results_tmp.jsonl"
  jq 'if .pin_type == "sha" then . + {run_count: 0, ran_during_window: false} else . end' \
    "$enriched_file" > "$tmp_file"
  mv "$tmp_file" "$enriched_file"

  # Replace results file
  mv "$enriched_file" "$RESULTS_FILE"

  progress "        $hits of $total at-risk workflows ran during the window"
}

# =============================================================================
# Output formatting
# =============================================================================

# Deduplicate results by repo+workflow+uses_ref. Outputs a JSON array.
deduped_results() {
  if [[ ! -s "$RESULTS_FILE" ]]; then
    echo "[]"
  else
    jq -s 'unique_by(.repo + "|" + .workflow + "|" + .uses_ref)' "$RESULTS_FILE"
  fi
}

output_json() {
  local results_array
  results_array=$(deduped_results)

  local total direct indirect pin_sha pin_tag pin_branch pin_none
  total=$(echo "$results_array" | jq 'length')
  direct=$(echo "$results_array" | jq '[.[] | select(.reference_type == "direct")] | length')
  indirect=$(echo "$results_array" | jq '[.[] | select(.reference_type == "indirect")] | length')
  pin_sha=$(echo "$results_array" | jq '[.[] | select(.pin_type == "sha")] | length')
  pin_tag=$(echo "$results_array" | jq '[.[] | select(.pin_type == "tag")] | length')
  pin_branch=$(echo "$results_array" | jq '[.[] | select(.pin_type == "branch")] | length')
  pin_none=$(echo "$results_array" | jq '[.[] | select(.pin_type == "none")] | length')

  local unique_repos
  unique_repos=$(echo "$results_array" | jq '[.[].repo] | unique | length')

  local json_output
  json_output=$(jq -n \
    --argjson actions "$(printf '%s\n' "${TARGET_ACTIONS[@]}" | jq -R . | jq -s .)" \
    --arg org "$ORG" \
    --arg scan_time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson depth "$MAX_DEPTH" \
    --argjson external "$SEARCH_EXTERNAL" \
    --argjson results "$results_array" \
    --argjson total "$total" \
    --argjson unique_repos "$unique_repos" \
    --argjson direct "$direct" \
    --argjson indirect "$indirect" \
    --argjson pin_sha "$pin_sha" \
    --argjson pin_tag "$pin_tag" \
    --argjson pin_branch "$pin_branch" \
    --argjson pin_none "$pin_none" \
    --argjson search_calls "$(counter_get search_calls)" \
    --argjson core_calls "$(counter_get core_calls)" \
    --argjson cache_hits "$(counter_get cache_hits)" \
    '{
      target_actions: $actions,
      org: $org,
      scan_time: $scan_time,
      options: {max_depth: $depth, search_external: $external},
      results: $results,
      summary: {
        total_references: $total,
        unique_repos: $unique_repos,
        direct: $direct,
        indirect: $indirect,
        pinning: {sha: $pin_sha, tag: $pin_tag, branch: $pin_branch, none: $pin_none}
      },
      api_usage: {search_calls: $search_calls, core_calls: $core_calls, cache_hits: $cache_hits}
    }')

  echo "$json_output"
}

output_text() {
  local results_array
  results_array=$(deduped_results)

  if [[ "$(echo "$results_array" | jq 'length')" -eq 0 ]]; then
    printf '\nNo references found.\n'
    return
  fi

  printf '\n'
  printf '%.0s=' {1..70}
  printf '\n'

  for action in "${TARGET_ACTIONS[@]}"; do
    printf ' Trace: %s in %s\n' "$action" "$ORG"
  done

  printf '%.0s=' {1..70}
  printf '\n'

  # Direct references
  local direct
  direct=$(echo "$results_array" | jq -c '[.[] | select(.reference_type == "direct")]')
  local direct_count
  direct_count=$(echo "$direct" | jq 'length')

  printf '\n DIRECT REFERENCES (%d)\n' "$direct_count"
  printf '%.0s-' {1..40}
  printf '\n'

  if [[ "$direct_count" -gt 0 ]]; then
    echo "$direct" | jq -r 'group_by(.repo)[] | .[0].repo as $repo |
      "\n  \($repo)",
      (.[] | "    \(.workflow)",
             "      \(.uses_ref)",
             "      pin:  \(.pin_type) (\(.pin_value)) \(if .pin_risk == "safe" then "✓" elif .pin_risk == "risky" then "⚠" else "✗" end)",
             "      reusable: \(if .is_reusable_workflow then "YES (workflow_call)" else "no" end)",
             (if .ran_during_window == true then "      RUNS:  \(.run_count) during window (verify)" elif .ran_during_window == false then "      runs:  0 (clear)" else empty end))' 2>/dev/null || true
  fi

  # Indirect references
  local indirect
  indirect=$(echo "$results_array" | jq -c '[.[] | select(.reference_type == "indirect")]')
  local indirect_count
  indirect_count=$(echo "$indirect" | jq 'length')

  printf '\n\n INDIRECT REFERENCES (%d) — via shared workflows\n' "$indirect_count"
  printf '%.0s-' {1..40}
  printf '\n'

  if [[ "$indirect_count" -gt 0 ]]; then
    echo "$indirect" | jq -r 'group_by(.repo)[] | .[0].repo as $repo |
      "\n  \($repo)",
      (.[] | "    \(.workflow)",
             "      \(.uses_ref)",
             "      pin:  \(.pin_type) (\(.pin_value)) \(if .pin_risk == "safe" then "✓" elif .pin_risk == "risky" then "⚠" else "✗" end)",
             (if .leaf_pin_type and .leaf_pin_type != .pin_type then "      leaf: \(.leaf_pin_type) (\(.leaf_pin_value)) \(if .leaf_pin_risk == "safe" then "✓" elif .leaf_pin_risk == "risky" then "⚠" else "✗" end) ← actual action pin" else empty end),
             "      via:  \(.via_workflow // "unknown")",
             "      chain: \(.chain | join(" → "))",
             (if .ran_during_window == true then "      RUNS:  \(.run_count) during window (verify)" elif .ran_during_window == false then "      runs:  0 (clear)" else empty end))' 2>/dev/null || true
  fi

  # Summary
  local total pin_sha pin_tag pin_branch pin_none unique_repos
  total=$(echo "$results_array" | jq 'length')
  unique_repos=$(echo "$results_array" | jq '[.[].repo] | unique | length')
  pin_sha=$(echo "$results_array" | jq '[.[] | select(.pin_type == "sha")] | length')
  pin_tag=$(echo "$results_array" | jq '[.[] | select(.pin_type == "tag")] | length')
  pin_branch=$(echo "$results_array" | jq '[.[] | select(.pin_type == "branch")] | length')
  pin_none=$(echo "$results_array" | jq '[.[] | select(.pin_type == "none")] | length')

  printf '\n\n PINNING SUMMARY\n'
  printf '%.0s-' {1..40}
  printf '\n'
  printf '  SHA-pinned:    %3d (safe)\n' "$pin_sha"
  printf '  Tag-pinned:    %3d (risky — tags are mutable)\n' "$pin_tag"
  printf '  Branch:        %3d (dangerous)\n' "$pin_branch"
  if [[ "$pin_none" -gt 0 ]]; then
    printf '  No version:    %3d (critical)\n' "$pin_none"
  fi
  printf '  ─────────────────\n'
  printf '  Total refs:    %3d across %d repos\n' "$total" "$unique_repos"

  # Compromised workflows section (only when --check-runs was used)
  # Compromised: ran during window AND leaf pin is not safe
  local compromised
  compromised=$(echo "$results_array" | jq -c '[.[] | select(.ran_during_window == true and .leaf_pin_risk != "safe")]')
  local compromised_count
  compromised_count=$(echo "$compromised" | jq 'length')

  # Safe runs: ran during window but leaf pin was safe (e.g., through vsp-github-actions@0.35.0)
  local safe_runs
  safe_runs=$(echo "$results_array" | jq -c '[.[] | select(.ran_during_window == true and .leaf_pin_risk == "safe")]')
  local safe_runs_count
  safe_runs_count=$(echo "$safe_runs" | jq 'length')

  if [[ "$compromised_count" -gt 0 ]]; then
    local compromised_repos
    compromised_repos=$(echo "$compromised" | jq '[.[].repo] | unique | length')

    printf '\n\n *** POTENTIALLY COMPROMISED: RAN DURING WINDOW (%d across %d repos) ***\n' "$compromised_count" "$compromised_repos"
    printf '%.0s-' {1..40}
    printf '\n'
    echo "$compromised" | jq -r 'group_by(.repo)[] | .[0].repo as $repo |
      "\n  \($repo)",
      (.[] | "    \(.workflow) - \(.run_count) runs [\(.leaf_pin_type // .pin_type) \(.leaf_pin_value // .pin_value)]")' 2>/dev/null || true
    printf '\n  Note: Verify via git history that the workflow used a compromised ref at\n'
    printf '  the time of execution. Branch/tag state may have changed since.\n'
  elif [[ -n "$CHECK_RUNS_FROM" ]]; then
    printf '\n\n No at-risk workflows ran during %s..%s\n' "$CHECK_RUNS_FROM" "$CHECK_RUNS_TO"
  fi

  if [[ "$safe_runs_count" -gt 0 ]]; then
    local safe_repos
    safe_repos=$(echo "$safe_runs" | jq '[.[].repo] | unique | length')

    printf '\n SAFE: Ran during window but leaf action was SHA/safe-pinned (%d across %d repos)\n' "$safe_runs_count" "$safe_repos"
    printf '%.0s-' {1..40}
    printf '\n'
    echo "$safe_runs" | jq -r 'group_by(.repo)[] | .[0].repo as $repo |
      "\n  \($repo)",
      (.[] | "    \(.workflow) [\(.leaf_pin_type) \(.leaf_pin_value)]")' 2>/dev/null || true
    printf '\n'
  fi

  printf '\n API USAGE\n'
  printf '%.0s-' {1..40}
  printf '\n'
  printf '  Search API calls: %d\n' "$(counter_get search_calls)"
  printf '  Core API calls:   %d\n' "$(counter_get core_calls)"
  printf '  Cache hits:       %d\n' "$(counter_get cache_hits)"
  printf '\n'
}

# Generate CSV report.
# Args: $1 = output file path
output_csv() {
  local outfile="$1"
  local results_array
  results_array=$(deduped_results)

  {
    echo "repo,workflow,uses_ref,reference_type,pin_type,pin_value,pin_risk,leaf_pin_type,leaf_pin_value,leaf_pin_risk,is_reusable,target_action,via_workflow,run_count,ran_during_window"
    echo "$results_array" | jq -r '.[] |
      [.repo, .workflow, .uses_ref, .reference_type, .pin_type, .pin_value, .pin_risk,
       (.leaf_pin_type // ""), (.leaf_pin_value // ""), (.leaf_pin_risk // ""),
       (if .is_reusable_workflow then "yes" else "no" end),
       .target_action, (.via_workflow // ""),
       (.run_count // ""), (if .ran_during_window == true then "yes" elif .ran_during_window == false then "no" else "" end)] | @csv'
  } > "$outfile"
}

# =============================================================================
# Main
# =============================================================================

main() {
  parse_args "$@"

  # Hide cursor during progress display
  hide_cursor

  # Set up temp directory for cache, results, and counters
  CACHE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gh-action-trace.XXXXXX")
  COUNTER_DIR="$CACHE_DIR"
  RESULTS_FILE="${CACHE_DIR}/results.jsonl"
  VISITED_WORKFLOWS_FILE="${CACHE_DIR}/visited_workflows.txt"
  VISITED_SEARCHES_FILE="${CACHE_DIR}/visited_searches.txt"
  touch "$RESULTS_FILE" "$VISITED_WORKFLOWS_FILE" "$VISITED_SEARCHES_FILE"

  # Initialize file-based counters
  counter_init search_calls
  counter_init core_calls
  counter_init cache_hits
  counter_init found
  counter_set search_remaining 10
  counter_set search_limit 10
  counter_set search_reset 0
  counter_set core_remaining 5000

  log "Cache dir: $CACHE_DIR"
  log "Org: $ORG"
  log "Actions: ${TARGET_ACTIONS[*]}"
  log "Max depth: $MAX_DEPTH"

  # Check gh auth
  gh auth status &>/dev/null || die "Not authenticated with gh. Run: gh auth login"

  # Refresh rate limits before starting so we know our budget
  refresh_rate_limit

  # Trace each target action
  for action in "${TARGET_ACTIONS[@]}"; do
    progress "Tracing: $action in $ORG (depth=$MAX_DEPTH)"
    trace_action "$action"
  done

  # Enrich indirect refs with leaf pin status
  enrich_leaf_pins

  # Check workflow runs if --check-runs was specified
  if [[ -n "$CHECK_RUNS_FROM" ]]; then
    check_workflow_runs
  fi

  show_cursor
  progress "Done. $(counter_get search_calls) search + $(counter_get core_calls) core API calls."

  # Build report filename base from org and actions
  local report_slug
  report_slug="${ORG}"
  for action in "${TARGET_ACTIONS[@]}"; do
    report_slug="${report_slug}_${action##*/}"
  done
  report_slug=$(echo "$report_slug" | tr '/' '-' | tr ' ' '-')
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local report_base="gh-action-trace_${report_slug}_${timestamp}"

  # Generate reports based on format
  local json_file="${report_base}.json"
  local csv_file="${report_base}.csv"

  case "$FORMAT" in
    text)
      output_text
      ;;
    json)
      if [[ -n "$OUTPUT_FILE" ]]; then
        output_json > "$OUTPUT_FILE"
      else
        output_json > "$json_file"
      fi
      output_csv "$csv_file"
      ;;
    both)
      output_text
      if [[ -n "$OUTPUT_FILE" ]]; then
        output_json > "$OUTPUT_FILE"
      else
        output_json > "$json_file"
      fi
      output_csv "$csv_file"
      ;;
  esac

  # Show report file paths (only for formats that generate files)
  if [[ "$FORMAT" != "text" ]]; then
    printf '\n REPORTS\n'
    printf '%.0s-' {1..40}
    printf '\n'
    if [[ -n "$OUTPUT_FILE" ]]; then
      printf '  JSON: %s\n' "$OUTPUT_FILE"
    else
      printf '  JSON: %s\n' "$json_file"
    fi
    printf '  CSV:  %s\n' "$csv_file"
    printf '\n'
  fi
}

main "$@"
