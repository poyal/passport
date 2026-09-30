# Keep the directory chooser while limiting every install to the current user.
!macro passportCurrentUser
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

!macro customInit
  # Reject the command-line override as well as removing the UI choice.
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro passportCurrentUser
!macroend

!macro customUnInit
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro passportCurrentUser
!macroend

!macro customInstallMode
  StrCpy $isForceMachineInstall "0"
  StrCpy $isForceCurrentInstall "1"
!macroend
