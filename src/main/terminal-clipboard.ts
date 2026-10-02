import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ShellId } from "../shared/terminal-config";
import { quotePastePaths, type TerminalClipboard } from "../shared/paste";
import {
  clipboardBlob,
  readClipboardFiles,
  type ClipboardEntry,
} from "./clipboard-files";

export async function prepareTerminalClipboard(options: {
  read: () => Promise<ClipboardEntry[]>;
  readNativeFiles?: () => Promise<string[]>;
  toPNG: (bytes: Buffer) => Buffer;
  userData: string;
  platform: string;
  shell?: ShellId;
  check: () => void;
}): Promise<TerminalClipboard> {
  options.check();
  const items = await options.read();
  const nativeFiles = await options.readNativeFiles?.();
  const files = nativeFiles?.length
    ? nativeFiles
    : await readClipboardFiles(items, options.platform);
  options.check();
  const requireLocal = () => {
    if (!options.shell)
      throw new Error(
        "SSH 터미널에는 파일·이미지를 먼저 원격으로 업로드한 뒤 원격 경로를 입력하세요.",
      );
    return options.shell;
  };
  if (files?.length)
    return {
      kind: "files",
      paths: files,
      text: quotePastePaths(files, requireLocal()),
    };
  const image =
    items
      .flatMap((item) => item.types.map((type) => ({ item, type })))
      .find(({ type }) => type === "image/png") ??
    items
      .flatMap((item) => item.types.map((type) => ({ item, type })))
      .find(({ type }) => type.startsWith("image/"));
  if (image) {
    const shell = requireLocal();
    const bytes = Buffer.from(
      await (
        await clipboardBlob(image.item, image.type, 20 * 1024 * 1024)
      ).arrayBuffer(),
    );
    const png = options.toPNG(bytes);
    if (!png.length || png.length > 20 * 1024 * 1024)
      throw new Error("이미지를 PNG로 변환할 수 없거나 20MB를 초과했습니다.");
    const directory = path.join(options.userData, "paste-images");
    const file = path.join(directory, `${randomUUID()}.png`);
    const text = quotePastePaths([file], shell);
    options.check();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, png, { flag: "wx", mode: 0o600 });
    options.check();
    return { kind: "image", path: file, text };
  }
  const parts: string[] = [];
  for (const item of items) {
    if (item.types.includes("text/plain"))
      parts.push(
        await (await clipboardBlob(item, "text/plain", 4 * 1024 * 1024)).text(),
      );
  }
  const text = parts.join("\n");
  if (text.length > 4 * 1024 * 1024)
    throw new Error("붙여넣을 텍스트가 4MB를 초과했습니다.");
  options.check();
  return text ? { kind: "text", text } : { kind: "empty" };
}
