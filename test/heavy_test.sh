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

# A caller's own shell may already have HEAVY_SLOTS/HEAVY_MIN_IDLE set,
# which would spuriously change override_slots' behavior below (it treats
# either as already-set and skips applying the file's value for it).
unset HEAVY_SLOTS HEAVY_MIN_IDLE

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
future=$(($(date +%s) + 3600))
past=$(($(date +%s) - 3600))

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

# An expired override (until already passed) never applies, so a below-floor
# min_idle in it must not warn either -- that warning used to fire before the
# expiry check even ran, describing a floor that was never actually applied.
printf '3 %s 2\n' "$past" > "$dir/slots"
idle_min_floored_warned=
min_idle=25
slots=2
override_slots 2> "$dir/err4" || true
assert_eq 'expired override does not change min_idle' 25 "$min_idle"
assert_no_match 'expired override does not warn about the floor' 'raising min_idle' "$(cat "$dir/err4")"

# HEAVY_MIN_IDLE already set in the environment wins over the file, so a
# below-floor min_idle in the file must not warn either -- same reasoning,
# the floor is only meaningful when the file's value would actually be used.
HEAVY_MIN_IDLE=30
idle_min_floored_warned=
min_idle=30
slots=2
printf '3 %s 2\n' "$future" > "$dir/slots"
override_slots 2> "$dir/err5"
assert_eq 'HEAVY_MIN_IDLE already set wins over the file' 30 "$min_idle"
assert_no_match 'HEAVY_MIN_IDLE already set suppresses the floor warning' 'raising min_idle' "$(cat "$dir/err5")"
unset HEAVY_MIN_IDLE

# An idle_min above 100 in the file is ignored (not clamped), warns once, and
# min_idle falls back to its current value.
printf '3 %s 150\n' "$future" > "$dir/slots"
idle_min_ignored_warned=
min_idle=25
slots=2
override_slots 2> "$dir/err6"
assert_eq 'out-of-range (>100) min_idle falls back to the current value' 25 "$min_idle"
assert_match 'out-of-range min_idle warns once' 'ignoring out-of-range' "$(cat "$dir/err6")"

if [ "$failures" -eq 0 ]; then
  echo "heavy_test.sh: all assertions passed"
else
  echo "heavy_test.sh: $failures assertion(s) failed" >&2
  exit 1
fi
