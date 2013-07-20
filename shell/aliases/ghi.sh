# ghi See: https://github.com/stephencelis/ghi

alias setcms='[[ -z $GHI_CURRENT_MILESTONE ]] && export GHI_CURRENT_MILESTONE=$(ghi milestone -S due_date --reverse | tail -1 | cut -f1 -d: | tr -d " \t\n") || true'

alias issues='setcms; ghi list -M $GHI_CURRENT_MILESTONE'
alias issuescol='setcms; ghi list -M $GHI_CURRENT_MILESTONE | tail +2 | sed "s/@$//" | sed "s/[0-9]\ $//" | column -s "[]" -t'

alias myissues='setcms; ghi list -M $GHI_CURRENT_MILESTONE --mine'
alias myissuescol='setcms; ghi list -M $GHI_CURRENT_MILESTONE --mine | tail +2 | sed "s/@$//" | sed "s/[0-9]\ $//" | column -s "[]" -t'

alias ghiw='ghi list -w'
alias ghil='ghi list'
alias ghilw='ghi list -w'

alias ghis='ghi show'
alias ghiws='ghi show -w'

alias ghic='ghi comment'
alias ghicw='ghi comment -w'

function ghico() { ghi assign $1 && ghi label $1 "In Progress" }
function ghici() { [[ ! -z $GHI_PM ]] && (ghi assign $1 $GHI_PM && ghi label $1 "Awaiting Approval") || (echo 'GHI_PM not set to a GitHub user! Issue not checked in!' && false ) }

# Labels
alias iblocked='ghi label -a blocked'
alias iblocking='ghi label -a blocking'
alias ienh='ghi label -a enhancement'
alias ibug='ghi label -a bug'

function ilab() { ghi label $1 -a $2 }
function ilabel() { ghi label $1 -a $2 }

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
