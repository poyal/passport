import path from "node:path";
import { runDownloadCommand, type DownloadRunner } from "../shared/download";

// No untrusted text is interpolated into PowerShell/C#. The file path is JSON
// on stdin. Only Save is exposed; Prompt/Execute/SaveWithUI are never invoked.
export const windowsDownloadScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$item = [Console]::In.ReadLine() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("73DB1241-1E85-4581-8E4F-A81E1D0F8C57"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAttachmentExecute {
 void SetClientTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
 void SetClientGuid(ref Guid guid);
 void SetLocalPath([MarshalAs(UnmanagedType.LPWStr)] string path);
 void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
 void SetSource([MarshalAs(UnmanagedType.LPWStr)] string source);
 void SetReferrer([MarshalAs(UnmanagedType.LPWStr)] string source);
 void CheckPolicy();
 void Prompt(IntPtr parent, int prompt, out int action);
 void Save();
 void Execute(IntPtr parent, [MarshalAs(UnmanagedType.LPWStr)] string verb, out IntPtr process);
 void SaveWithUI(IntPtr parent);
 void ClearClientState();
}
public static class PassportAttachment {
 public static void Save(string path) {
  object obj = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("4125DD96-E03A-4103-8F70-E0597D803B9C")));
  try {
   var attachment = (IAttachmentExecute)obj;
   var id = new Guid("F5E926CA-321A-4A35-8862-EAB4E6947F10");
   attachment.SetClientGuid(ref id);
   attachment.SetLocalPath(path);
   attachment.SetFileName(System.IO.Path.GetFileName(path));
   attachment.SetSource("about:internet");
   attachment.Save();
  } finally { Marshal.FinalReleaseComObject(obj); }
 }
}
'@
if ((Get-Item -LiteralPath $item.path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
[PassportAttachment]::Save($item.path)
if (-not (Test-Path -LiteralPath $item.path -PathType Leaf)) { throw 'File blocked' }
$zone = "[ZoneTransfer]\r\nZoneId=3\r\n"
[IO.File]::WriteAllText($item.path + ':Zone.Identifier', $zone)
if ([IO.File]::ReadAllText($item.path + ':Zone.Identifier') -ne $zone) { throw 'Unprotected destination' }
`;
export function createWindowsDownload(
  run: DownloadRunner = runDownloadCommand,
  env = process.env,
) {
  return async (file: string) => {
    const executable = path.win32.join(
      env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    // UTF-16LE is PowerShell's documented EncodedCommand encoding.
    const script = windowsDownloadScript.replace(
      '"[ZoneTransfer]\\r\\nZoneId=3\\r\\n"',
      '"[ZoneTransfer]`r`nZoneId=3`r`n"',
    );
    await run(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      JSON.stringify({ path: file }) + "\n",
    );
  };
}
