#!/usr/bin/env bash
# Today's agenda, for the status-bar clock click.
#
# ical's own table/plain output is too wide for a tmux window (the table is a
# fixed ~130 columns, and plain dumps the full Teams location list), so format
# the JSON into a compact list instead.
#
# Two kinds of duplicates get collapsed:
#   - "VA (outlook-cli)" is an iCloud subscription mirroring the
#     Eric.Boehs@va.gov CalDAV calendar, so it is excluded outright.
#   - Meetings invited to both work calendars (oddball.io and va.gov) are
#     deduped on title + start time.

printf '\n  \033[1m%s\033[0m\n\n' "$(date '+%A, %B %-d')"

# Previous/current/next month for context. BSD cal reverse-highlights today
# only when stdout is a tty, so leave it unpiped -- indenting it through sed
# costs the highlight, which is the main reason to show a calendar at all.
cal -A 1 -B 1
echo

ical today -o json --exclude-calendar "VA (outlook-cli)" 2>/dev/null | jq -r '
  map(select(.status != "canceled"))
  | unique_by(.title + .start_date)
  | sort_by((.all_day == false), .start_date)
  | if length == 0 then "  Nothing on the calendar today." else
      .[]
      | (if .all_day then "  all-day      "
         else "  " + (.start_date|fromdateiso8601|strflocaltime("%H:%M")) + "-"
                  + (.end_date|fromdateiso8601|strflocaltime("%H:%M")) + "  " end)
        + (.title | if length > 62 then .[0:59] + "..." else . end)
    end
'

echo

# ical exits immediately, so drop into an interactive shell to keep the window
# usable (same pattern as the `bind C` / `bind F` windows).
exec "${SHELL:-/bin/zsh}" -i
