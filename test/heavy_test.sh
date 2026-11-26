#!/usr/bin/env bash
# Tests for bin/heavy's override_slots function (the ~/Library/Caches/heavy/slots
# file parser). Run: test/heavy_test.sh
#
# bin/heavy itself is an infinite-loop daemon wrapper with no entry point to
# call in isolation, so this extracts just the override_slots function body
# (between its `override_slots() {` header and the matching top-level `}`)
# and sources it, instead of running the whole script.

set -euo pipefail

heavy_bin="$(cd "$(dirname "$0")/.." && pwd)/bin/heavy"
fn=$(awk '/^override_slots\(\) \{/{p=1} p{print} p && /^}/{exit}' "$heavy_bin")
[ -n "$fn" ] || { echo "FAIL: could not extract override_slots from $heavy_bin" >&2; exit 1; }
eval "$fn"

failures=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label: expected [$expected], got [$actual]" >&2
    failures=$((failures + 1))
  fi
}
assert_match() {
  local label="$1" pattern="$2" actual="$3"
  case "$actual" in
    *"$pattern"*) ;;
    *) echo "FAIL: $label: expected output to contain [$pattern], got [$actual]" >&2; failures=$((failures + 1)) ;;
  esac
}
assert_no_match() {
  local label="$1" pattern="$2" actual="$3"
  case "$actual" in
    *"$pattern"*) echo "FAIL: $label: expected output to NOT contain [$pattern], got [$actual]" >&2
                  failures=$((failures + 1)) ;;
    *) ;;
  esac
}

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
future=$(($(date +%s) + 3600))

# A command substitution runs override_slots in a subshell, so its variable
# assignments (min_idle, idle_min_floored_warned) would not be visible back
# here -- stderr is redirected to a file instead, and override_slots is
# called directly in this shell.

# A below-floor min_idle (2) is silently raised to 5 and warned once.
printf '3 %s 2\n' "$future" > "$dir/slots"
idle_min_floored_warned=
min_idle=25
slots=2
override_slots 2> "$dir/err"
assert_eq 'min_idle is floored to 5' 5 "$min_idle"
assert_match 'first floor hit warns' 'raising min_idle' "$(cat "$dir/err")"

# The warning does not repeat on a later call in the same process.
override_slots 2> "$dir/err2"
assert_eq 'min_idle stays 5' 5 "$min_idle"
assert_no_match 'second floor hit is silent' 'raising min_idle' "$(cat "$dir/err2")"

# A valid (>= 5) min_idle in the file is left alone and never warns.
printf '3 %s 10\n' "$future" > "$dir/slots"
idle_min_floored_warned=
min_idle=25
slots=2
override_slots 2> "$dir/err3"
assert_eq 'in-range min_idle is unchanged' 10 "$min_idle"
assert_no_match 'in-range min_idle does not warn' 'raising min_idle' "$(cat "$dir/err3")"

if [ "$failures" -eq 0 ]; then
  echo "heavy_test.sh: all assertions passed"
else
  echo "heavy_test.sh: $failures assertion(s) failed" >&2
  exit 1
fi
