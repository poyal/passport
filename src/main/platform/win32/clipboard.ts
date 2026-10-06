import path from "node:path";
import type { ClipboardPlatform } from "../contracts";
import {
  clipboardBlob,
  clipboardEntries,
  rawClipboardEntries,
  readFileURLItems,
  validateFilePaths,
  clipboardCommand,
} from "../shared/clipboard";
export function decodeDropFiles(data: Buffer): string[] {
  if (data.length < 24) throw new Error("Windows 파일 목록이 손상되었습니다.");
  const offset = data.readUInt32LE(0);
  if (
    offset < 20 ||
    offset > data.length - 4 ||
    offset % 2 ||
    !data.readUInt32LE(16) ||
    (data.length - offset) % 2
  )
    throw new Error("Windows Unicode 파일 목록을 읽을 수 없습니다.");
  const list = data.subarray(offset).toString("utf16le");
  if (!list.endsWith("\0\0"))
    throw new Error("Windows 파일 목록이 끝나지 않았습니다.");
  return list.slice(0, -2).split("\0").filter(Boolean);
}

export function createWindowsClipboard(
  run = clipboardCommand,
  env = process.env,
): ClipboardPlatform {
  const windowsFileList = async (): Promise<string[]> => {
    const script =
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $files=@([System.Windows.Forms.Clipboard]::GetFileDropList()); ConvertTo-Json -InputObject $files -Compress";
    return JSON.parse(
      await run(
        path.win32.join(
          env.SystemRoot || "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      ),
    );
  };
  return {
    async readFiles(items) {
      const entries = clipboardEntries(items);
      const raw = (name: string) => rawClipboardEntries(entries, name);
      let paths: string[];
      const drop = raw("CF_HDROP")[0];
      if (drop)
        paths = decodeDropFiles(
          Buffer.from(
            await (
              await clipboardBlob(drop.item, drop.type, 4 * 1024 * 1024)
            ).arrayBuffer(),
          ),
        );
      else if (
        ["FileNameW", "FileName", "FileDrop"].some((name) => raw(name).length)
      ) {
        paths = await windowsFileList();
        const first = raw("FileNameW")[0];
        if (first) {
          const expected = Buffer.from(
            await (
              await clipboardBlob(first.item, first.type, 4 * 1024 * 1024)
            ).arrayBuffer(),
          )
            .toString("utf16le")
            .replace(/\0+$/, "");
          if (
            !paths.length ||
            paths[0].toLowerCase() !== expected.toLowerCase()
          )
            throw new Error(
              "읽는 동안 파일 클립보드가 변경되었습니다. 다시 붙여넣어 주세요.",
            );
        }
      } else return readFileURLItems(entries, "win32");
      return validateFilePaths(paths, "win32");
    },
  };
}
