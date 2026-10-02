param(
    [Parameter(Mandatory=$true)][string]$IconPath,
    [Parameter(Mandatory=$true)][string]$WindowHandles
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PassportWindowIcons {
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr instance, string file, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@
function Get-IconPixels([System.Drawing.Bitmap]$Bitmap) {
    $passportPixels = New-Object byte[] ($Bitmap.Width * $Bitmap.Height * 4)
    $passportOffset = 0
    for ($passportY = 0; $passportY -lt $Bitmap.Height; $passportY++) {
        for ($passportX = 0; $passportX -lt $Bitmap.Width; $passportX++) {
            $passportColor = $Bitmap.GetPixel($passportX, $passportY)
            # RGB under fully transparent pixels does not affect the icon.
            $passportPixels[$passportOffset++] = $passportColor.A
            $passportPixels[$passportOffset++] = $(if ($passportColor.A) { $passportColor.R } else { 0 })
            $passportPixels[$passportOffset++] = $(if ($passportColor.A) { $passportColor.G } else { 0 })
            $passportPixels[$passportOffset++] = $(if ($passportColor.A) { $passportColor.B } else { 0 })
        }
    }
    $passportHasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($passportHasher.ComputeHash($passportPixels)).Replace('-', '').ToLowerInvariant() }
    finally { $passportHasher.Dispose() }
}
$passportResults = @()
foreach ($passportWindow in $WindowHandles.Split(',')) {
    foreach ($passportKind in @(0, 1)) {
        $passportHandle = [PassportWindowIcons]::SendMessage([IntPtr][long]$passportWindow, 127, [IntPtr]$passportKind, [IntPtr]::Zero)
        if ($passportHandle -eq [IntPtr]::Zero) { throw "Window $passportWindow has no explicit icon ($passportKind)." }
        $passportActual = [System.Drawing.Icon]::FromHandle($passportHandle).ToBitmap()
        try {
            if ($passportActual.Width -gt 256 -or $passportActual.Height -gt 256) { throw 'Window has an oversized PNG icon.' }
            $passportExpectedHandle = [PassportWindowIcons]::LoadImage([IntPtr]::Zero, $IconPath, 1, $passportActual.Width, $passportActual.Height, 16)
            if ($passportExpectedHandle -eq [IntPtr]::Zero) { throw 'Cannot load expected Passport ICO.' }
            try {
                $passportExpected = [System.Drawing.Icon]::FromHandle($passportExpectedHandle).ToBitmap()
                try {
                    $passportActualHash = Get-IconPixels $passportActual
                    if ($passportActualHash -ne (Get-IconPixels $passportExpected)) { throw "Window $passportWindow icon differs from Passport ICO ($passportKind)." }
                    $passportResults += @{window=$passportWindow;kind=$passportKind;width=$passportActual.Width;height=$passportActual.Height;pixelsSha256=$passportActualHash}
                } finally { $passportExpected.Dispose() }
            } finally { [void][PassportWindowIcons]::DestroyIcon($passportExpectedHandle) }
        } finally { $passportActual.Dispose() }
    }
}
$passportResults | ConvertTo-Json -Depth 3 -Compress
