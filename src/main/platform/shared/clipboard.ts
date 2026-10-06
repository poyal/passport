import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClipboardEntry } from "../contracts";
export type { ClipboardEntry } from "../contracts";
export const osClipboardFormat = (name: string) =>
  `electron application/osclipboard;format="${name}"`;

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

export function clipboardCommand(
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

export const clipboardEntries = (items: ClipboardEntry[]) =>
  items.flatMap((item) => item.types.map((type) => ({ item, type })));
export const rawClipboardEntries = (
  entries: ReturnType<typeof clipboardEntries>,
  name: string,
) =>
  entries.filter(
    ({ type }) => type.toLowerCase() === osClipboardFormat(name).toLowerCase(),
  );
export async function readFileURLItems(
  entries: ReturnType<typeof clipboardEntries>,
  platform: string,
): Promise<string[] | undefined> {
  const urls = entries.filter(
    ({ type }) =>
      type === "text/uri-list" ||
      (platform === "darwin" && type === osClipboardFormat("public.file-url")),
  );
  const paths: string[] = [];
  for (const { item, type } of urls) {
    const text = await (
      await clipboardBlob(item, type, 4 * 1024 * 1024)
    ).text();
    if (
      type === "text/uri-list" &&
      !text.split(/\r?\n/).some((line) => line.startsWith("file:"))
    )
      continue;
    paths.push(...decodeFileURLs(text, platform));
  }
  return paths.length ? validateFilePaths(paths, platform) : undefined;
}
