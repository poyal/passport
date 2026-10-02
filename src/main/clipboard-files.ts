import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ClipboardEntry {
  types: readonly string[];
  getType(type: string): Promise<unknown>;
}
export const osClipboardFormat = (name: string) =>
  `electron application/osclipboard;format="${name}"`;

// Chromium can expose only Finder's display-name text. Read the file URLs
// from AppKit itself instead of trying to reconstruct a path from that text.
export const macFileClipboardScript = `
function run(argv) {
  ObjC.import('AppKit');
  const pb = argv.length ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard;
  const generation = Number(pb.changeCount);
  const options = $.NSMutableDictionary.dictionary;
  options.setObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
  const urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), options);
  const paths = [];
  if (urls) for (let i = 0; i < urls.count; i++) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
  }
  if (!paths.length) {
    const legacy = ObjC.deepUnwrap(pb.propertyListForType('NSFilenamesPboardType'));
    if (Array.isArray(legacy)) paths.push(...legacy);
  }
  if (Number(pb.changeCount) !== generation) throw new Error('Clipboard changed while reading files');
  return JSON.stringify(paths);
}`;

// A named pasteboard lets tests exercise AppKit without touching the user's
// general clipboard. Production calls never supply a name.
export async function readMacClipboardFiles(
  pasteboardName?: string,
): Promise<string[]> {
  const result = await command("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    macFileClipboardScript,
    ...(pasteboardName ? [pasteboardName] : []),
  ]);
  return validateFilePaths(JSON.parse(result), "darwin");
}

export async function clipboardBlob(
  item: ClipboardEntry,
  type: string,
  limit: number,
): Promise<Blob> {
  const data = await item.getType(type);
  if (!(data instanceof Blob) || data.size > limit)
    throw new Error("클립보드 데이터가 잘못되었거나 허용 크기를 초과했습니다.");
  return data;
}

export function validateFilePaths(paths: unknown, platform: string): string[] {
  if (
    !Array.isArray(paths) ||
    paths.length > 1000 ||
    paths.some(
      (file) =>
        typeof file !== "string" ||
        !file ||
        file.length > 32768 ||
        /[\x00-\x1f\x7f]/.test(file) ||
        !(platform === "win32"
          ? /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(file)
          : path.posix.isAbsolute(file)),
    )
  )
    throw new Error("클립보드의 파일 목록을 읽을 수 없습니다.");
  return paths;
}

export function decodeFileURLs(text: string, platform: string): string[] {
  return text
    .replace(/\0+$/, "")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const url = new URL(line);
      if (url.protocol !== "file:" || url.search || url.hash)
        throw new Error("로컬 파일 URL만 붙여넣을 수 있습니다.");
      return fileURLToPath(url, { windows: platform === "win32" });
    });
}

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

function command(
  file: string,
  args: string[],
  input?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) =>
        error
          ? reject(new Error("운영체제의 파일 클립보드를 읽지 못했습니다."))
          : resolve(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

// Read all Explorer entries when Chromium exposes only a FileNameW marker.
// Constant code only: clipboard paths are never interpolated into a command.
async function windowsFileList(): Promise<string[]> {
  const script =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $files=@([System.Windows.Forms.Clipboard]::GetFileDropList()); ConvertTo-Json -InputObject $files -Compress";
  return JSON.parse(
    await command(
      path.win32.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
    ),
  );
}

export async function readClipboardFiles(
  items: ClipboardEntry[],
  platform: string,
): Promise<string[] | undefined> {
  const entries = items.flatMap((item) =>
    item.types.map((type) => ({ item, type })),
  );
  const raw = (name: string) =>
    entries.filter(
      ({ type }) =>
        type.toLowerCase() === osClipboardFormat(name).toLowerCase(),
    );
  let paths: string[] | undefined;
  if (platform === "darwin" && raw("NSFilenamesPboardType").length) {
    // Finder's legacy list contains every selected file, including on versions
    // where the public.file-url representation exposes only the first item.
    const { item, type } = raw("NSFilenamesPboardType")[0];
    const bytes = Buffer.from(
      await (await clipboardBlob(item, type, 4 * 1024 * 1024)).arrayBuffer(),
    );
    paths = JSON.parse(
      await command(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", "--", "-"],
        bytes,
      ),
    );
  } else if (platform === "win32" && raw("CF_HDROP").length) {
    const { item, type } = raw("CF_HDROP")[0];
    paths = decodeDropFiles(
      Buffer.from(
        await (await clipboardBlob(item, type, 4 * 1024 * 1024)).arrayBuffer(),
      ),
    );
  } else if (
    platform === "win32" &&
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
      if (!paths.length || paths[0].toLowerCase() !== expected.toLowerCase())
        throw new Error(
          "읽는 동안 파일 클립보드가 변경되었습니다. 다시 붙여넣어 주세요.",
        );
    }
  } else {
    const urls = entries.filter(
      ({ type }) =>
        type === "text/uri-list" ||
        (platform === "darwin" &&
          type === osClipboardFormat("public.file-url")),
    );
    if (urls.length) {
      paths = [];
      for (const { item, type } of urls) {
        const text = await (
          await clipboardBlob(item, type, 4 * 1024 * 1024)
        ).text();
        // A browser link is text, not a copied file.
        if (
          type === "text/uri-list" &&
          !text.split(/\r?\n/).some((line) => line.startsWith("file:"))
        )
          continue;
        paths.push(...decodeFileURLs(text, platform));
      }
      if (!paths.length) paths = undefined;
    }
  }
  return paths === undefined ? undefined : validateFilePaths(paths, platform);
}
