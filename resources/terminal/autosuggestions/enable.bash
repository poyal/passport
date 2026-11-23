# An existing ble.sh belongs to the user's profile.
[[ ${BLE_VERSION-} ]] && return 0
if [[ ! $USER && $USERNAME ]]; then USER=$USERNAME; fi
source "${BASH_SOURCE[0]%/*}/bash/ble.sh" --norc --attach=prompt || return 1
bleopt highlight_syntax= highlight_filename= complete_auto_menu= \
  complete_auto_complete_opts=suppress-inside-line complete_auto_complete=1 prompt_eol_mark= \
  exec_errexit_mark= exec_elapsed_mark=
ble-bind -m auto_complete -f end auto_complete/cancel-default
