# ghi See: https://github.com/stephencelis/ghi

alias setcms='[[ -z $GHI_CURRENT_MILESTONE ]] && export GHI_CURRENT_MILESTONE=$( ghi milestone -S due_date -v | grep -E "Past due|^Due" -B5| grep -E "^\#" | tail -1 | cut -f1 -d:|tr -d "# \t\n") || true'


alias ic='issues COL'
function issues() { setcms; ghi list -M $GHI_CURRENT_MILESTONE $@ }

alias mic='myissues COL'
function myissues() { setcms; ghi list -M $GHI_CURRENT_MILESTONE --mine $@ }

function notmyissues() { issues $@ COL | grep -vE "^\s*($(myissues COL |awk '{print $1}' | tr -d ' \t'|paste -s -d'|' -))" }

alias teampoints='for i in $(echo ${GHI_TEAM:=$USER}); do echo -n "$i: "; issues -u $i COL POINTS; done | grep -Ev " 0$"|sort -nrk2'

alias ghiw='ghi list -w'

alias ghil='ghi list'
alias ghilw='ghi list -w'

alias ghis='ghi show'
alias ghisw='ghi show -w'

alias ghio='ghi open'
alias ghiow='ghi open -w'

alias ghicl='ghi close'
alias ghiclw='ghi close -w'

alias ghie='ghi edit'
alias ghiew='ghi edit -w'

alias ghico='ghi comment'
alias ghicow='ghi comment -w'

alias ghia='ghi assign'
alias ghiaw='ghi assign -w'

alias ghim='ghi milestone'
alias ghimw='ghi milestone -w'

function ghisg() { ghi show $(ghi list | grep -i "$1" | head -1 | awk '{print $1}') }
function ghisgv() { ghi show $(ghi list -v | grep -i -B 5000 "$1" | tail -r |grep -m1 -oE "^#[0-9]+:"|tr -d '#:')}

function istart() { ghi label $1 | grep "In Progress" && echo "Aborted. \nAlready in progress!" || (ghi assign $1 && ghi label $1 "In Progress") }
function ifinish() { [[ ! -z $GHI_PM ]] && (ghi assign $1 $GHI_PM && ghi label $1 "Awaiting Approval") || (echo 'GHI_PM not set to a GitHub user! Issue not checked in!' && false ) }

# Labels
function ilab() { ghi label $1 -a $2 }
function ilabel() { ghi label $1 -a $2 }

alias iblocked='ghi label -a blocked'
alias iblocking='ghi label -a blocking'

alias ienh='ghi label -a enhancement'
alias ibug='ghi label -a bug'

function ims() { setcms; ghi edit ${1:=9999999} -M ${2:=$GHI_CURRENT_MILESTONE} } # Usage: ims <issueno> [milestoneno] (defaults to earliest milestone)

function ilow() { [[ -n $1 ]] &&
  ghi label -d "Medium%20Priority" $1 > /dev/null &&
  ghi label -d "High%20Priority"   $1 > /dev/null &&
  ghi label -a "Low Priority" $1
}
function imed() { [[ -n $1 ]] &&
  ghi label -d "Low%20Priority" $1 > /dev/null &&
  ghi label -d "High%20Priority" $1 > /dev/null &&
  ghi label -a "Medium Priority" $1
}
function ihigh() { [[ -n $1 ]] &&
  ghi label -d "Low%20Priority"    $1 > /dev/null &&
  ghi label -d "Medium%20Priority" $1 > /dev/null &&
  ghi label -a "High Priority" $1
}

function iest() {
  if [[ $# -eq 2 ]]; then
    for i in 0 1 2 4 8; do
      [[ "$i" -ne "$1" ]] && ghi label -d "$i%20points" $2 > /dev/null
    done

    ghi label -a "$1 points" $2
  fi
}
