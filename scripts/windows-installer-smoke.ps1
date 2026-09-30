param([Parameter(Mandatory = $true)][string]$InstallerPath)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class PassportInstallerControl {
  public string name;
  public string type;
  public int style;
}
public static class PassportInstallerWindows {
  public delegate bool EnumWindowProc(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window, EnumWindowProc callback, IntPtr state);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr count, StringBuilder text);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  public static List<PassportInstallerControl> Children(IntPtr parent) {
    var controls = new List<PassportInstallerControl>();
    EnumChildWindows(parent, (window, state) => {
      var text = new StringBuilder(2048);
      var name = new StringBuilder(256);
      SendMessage(window, 0x000D, new IntPtr(text.Capacity), text);
      GetClassName(window, name, name.Capacity);
      controls.Add(new PassportInstallerControl { name = text.ToString(), type = name.ToString(), style = GetWindowLong(window, -16) });
      return true;
    }, IntPtr.Zero);
    return controls;
  }
  public static IntPtr FindForProcess(int process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, state) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      var name = new StringBuilder(256);
      GetClassName(window, name, name.Capacity);
      if (owner == process && name.ToString() == "#32770") { found = window; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$taskReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'release'))
$taskInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not $taskInstaller.StartsWith($taskReleaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer must be inside the workspace release directory.' }
$taskRoot = Split-Path -Parent $taskInstaller
$taskPreviewPath = Join-Path $taskRoot 'installer-scope-preview'
$taskProcess = Start-Process -FilePath $taskInstaller -ArgumentList ('/D=' + $taskPreviewPath) -WindowStyle Hidden -PassThru
try {
  $taskControls = @()
  $taskEdits = @()
  for ($taskAttempt = 0; $taskAttempt -lt 100; $taskAttempt++) {
    $taskHandle = [PassportInstallerWindows]::FindForProcess($taskProcess.Id)
    if ($taskHandle -ne [IntPtr]::Zero) {
      $taskControls = @([PassportInstallerWindows]::Children($taskHandle))
      $taskEdits = @($taskControls | Where-Object type -EQ 'Edit')
      if ($taskEdits.Count -gt 0) { break }
    }
    Start-Sleep -Milliseconds 150
  }
  if ($taskEdits.Count -eq 0) {
    $taskProcess.Refresh()
    [ordered]@{ processId = $taskProcess.Id; hasExited = $taskProcess.HasExited; exitCode = $taskProcess.ExitCode; handle = $taskHandle.ToInt64(); controls = $taskControls } | ConvertTo-Json -Depth 4
    throw 'Expected the installation directory chooser as the first page.'
  }
  if (@($taskControls | Where-Object { $_.type -eq 'Button' -and ($_.style -band 15) -in @(4,9) }).Count -ne 0) { throw 'Install scope radio buttons are still present.' }
  $taskValues = @($taskEdits | ForEach-Object { $_.name.TrimEnd() })
  if ($taskValues -notcontains $taskPreviewPath) { [ordered]@{ expectedPath = $taskPreviewPath; values = $taskValues; controls = $taskControls } | ConvertTo-Json -Depth 4; throw 'The directory chooser did not retain the requested path.' }
  [ordered]@{ directoryChooserFirst = $true; scopeRadioButtons = 0; displayedPaths = $taskValues; controls = $taskControls } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $taskRoot 'installer-ui-check.json')
} finally {
  $taskProcess.Refresh()
  if (-not $taskProcess.HasExited) { Stop-Process -Id $taskProcess.Id }
}
$taskRejectedPath = Join-Path $taskRoot 'rejected-allusers'
$taskProcess = Start-Process -FilePath $taskInstaller -ArgumentList @('/S', '/allusers', ('/D=' + $taskRejectedPath)) -WindowStyle Hidden -Wait -PassThru
if ($taskProcess.ExitCode -ne 2) { throw "Expected /allusers to exit with code 2, received $($taskProcess.ExitCode)." }
if (Test-Path -LiteralPath (Join-Path $taskRejectedPath 'Passport.exe')) { throw 'The forbidden all-users installation created an executable.' }
$taskResult = [ordered]@{ directoryChooserFirst = $true; installScopeSelectionRemoved = $true; allUsersOverrideRejected = $true; rejectedExitCode = $taskProcess.ExitCode }
$taskResult | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $taskRoot 'installer-scope-check.json')
$taskResult | ConvertTo-Json
