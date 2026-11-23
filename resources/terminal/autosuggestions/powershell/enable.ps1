# Runs in the interactive host after the user's profiles, with script-local variables.
$ErrorActionPreference = 'Stop'
Import-Module PSReadLine
$options = (Get-Command Set-PSReadLineOption).Parameters
if (!$options.ContainsKey('PredictionSource')) { return }

Set-PSReadLineOption -PredictionSource History
if (!$options.ContainsKey('PredictionViewStyle')) { return }
Set-PSReadLineOption -PredictionViewStyle InlineView
if ($PSVersionTable.PSVersion -lt [version]'7.2') { return }

# Older PSReadLine releases still retain history if predictor registration fails.
if (!('Passport.Terminal.PathPredictor' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'PathPredictor.cs')
    $predictor = [Passport.Terminal.PathPredictor]::new($ExecutionContext.SessionState.Path, [Microsoft.PowerShell.PSConsoleReadLine])
    [System.Management.Automation.Subsystem.SubsystemManager]::RegisterSubsystem('CommandPredictor', $predictor)
}
Set-PSReadLineOption -PredictionSource HistoryAndPlugin
