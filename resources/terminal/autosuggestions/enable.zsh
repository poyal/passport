# User startup has finished. Keep any existing instance and its widget bindings.
(( ${+functions[_zsh_autosuggest_start]} )) && return 0
if (( ! ${+functions[compdef]} )); then
  autoload -Uz compinit
  compinit -i -D || return 1
fi
ZSH_AUTOSUGGEST_STRATEGY=(history completion)
ZSH_AUTOSUGGEST_ACCEPT_WIDGETS=(forward-char vi-forward-char)
source "${${(%):-%x}:A:h}/zsh/zsh-autosuggestions.zsh"
