# ghi See: https://github.com/stephencelis/ghi

alias setcms='[[ -z $GHI_CURRENT_MILESTONE ]] && export GHI_CURRENT_MILESTONE=$( ghi milestone -S due_date -v | grep -E "Past due|^Due" -B5| grep -E "^\#" | tail -1 | cut -f1 -d:|tr -d "# \t\n") || true'

function issues() { setcms; ghi list -M $GHI_CURRENT_MILESTONE $@ }

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

alias inext="ghi list --mine --label 'In Progress' && ghi list --mine --label 'High Priority'"
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

function iest0() { [[ -n $1 ]] &&
  ghi label -d "1%20point"  $1 > /dev/null &&
  ghi label -d "2%20points" $1 > /dev/null &&
  ghi label -d "4%20points" $1 > /dev/null &&
  ghi label -d "8%20points" $1 > /dev/null &&
  ghi label -a "0 points" $1
}
function iest1() { [[ -n $1 ]] &&
  ghi label -d "0%20points" $1 > /dev/null &&
  ghi label -d "2%20points" $1 > /dev/null &&
  ghi label -d "4%20points" $1 > /dev/null &&
  ghi label -d "8%20points" $1 > /dev/null &&
  ghi label -a "1 point" $1
}
function iest2() { [[ -n $1 ]] &&
  ghi label -d "0%20points" $1 > /dev/null &&
  ghi label -d "1%20point"  $1 > /dev/null &&
  ghi label -d "4%20points" $1 > /dev/null &&
  ghi label -d "8%20points" $1 > /dev/null &&
  ghi label -a "2 points" $1
}
function iest4() { [[ -n $1 ]] &&
  ghi label -d "0%20points" $1 > /dev/null &&
  ghi label -d "1%20point"  $1 > /dev/null &&
  ghi label -d "2%20points" $1 > /dev/null &&
  ghi label -d "8%20points" $1 > /dev/null &&
  ghi label -a "4 points" $1
}
function iest8() { [[ -n $1 ]] &&
  ghi label -d "0%20points" $1 > /dev/null &&
  ghi label -d "1%20point"  $1 > /dev/null &&
  ghi label -d "2%20points" $1 > /dev/null &&
  ghi label -d "4%20points" $1 > /dev/null &&
  ghi label -a "8 points" $1
}
