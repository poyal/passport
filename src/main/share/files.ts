import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  shareFileLimit,
  shareFileName,
  type ShareOffer,
} from "../../shared/share";

export function validateSignature(name: string, head: Buffer) {
  const ext = name.split(".").pop()!.toLowerCase();
  const hex = head.toString("hex");
  const signatures: Record<string, boolean> = {
    pdf: head.subarray(0, 5).toString() === "%PDF-",
    png: hex.startsWith("89504e470d0a1a0a"),
    jpg: hex.startsWith("ffd8ff"),
    jpeg: hex.startsWith("ffd8ff"),
    gif: /^GIF8[79]a/.test(head.toString("ascii")),
    webp:
      head.subarray(0, 4).toString() === "RIFF" &&
      head.subarray(8, 12).toString() === "WEBP",
    zip: /^(504b0304|504b0506|504b0708)/.test(hex),
    "7z": hex.startsWith("377abcaf271c"),
  };
  for (const format of ["docx", "xlsx", "pptx", "hwpx"])
    signatures[format] = hex.startsWith("504b0304");
  if (ext in signatures && !signatures[ext])
    throw new Error("확장자와 파일 서명이 일치하지 않습니다.");
  if (["txt", "md", "csv", "html", "htm"].includes(ext)) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(head, {
      stream: true,
    });
    if (
      text.includes("\0") ||
      hex.startsWith("4d5a") ||
      hex.startsWith("7f454c46")
    )
      throw new Error("UTF-8 문서 파일이 아닙니다.");
  }
}
export async function readSendFile(file: string, limit = shareFileLimit) {
  if (!path.isAbsolute(file)) throw new Error("파일의 절대 경로가 필요합니다.");
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error("허용 크기의 일반 파일만 전송할 수 있습니다.");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      !opened.isFile() ||
      opened.size > limit
    )
      throw new Error("파일이 변경되었습니다.");
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (!read.bytesRead) throw new Error("파일이 변경되었습니다.");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new Error("파일이 변경되었습니다. 다시 보내 주세요.");
    return data;
  } finally {
    await handle.close();
  }
}
export async function secureDirectory(directory: string) {
  if (!path.isAbsolute(directory))
    throw new Error("다운로드 폴더를 선택하세요.");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("일반 로컬 폴더를 선택하세요.");
  return fs.realpath(directory);
}
export async function receiveFile(
  request: IncomingMessage,
  offer: ShareOffer,
  directory: string,
  protect: (file: string) => Promise<void>,
  valid: () => void,
  progress: (bytes: number) => void,
  trackStaging: (directory: string) => Promise<() => unknown>,
) {
  const name = shareFileName(offer.name);
  const root = await secureDirectory(directory);
  const temp = await fs.mkdtemp(path.join(root, ".passport-receive-"));
  const staged = path.join(temp, name);
  let final: string | undefined;
  let forget: (() => unknown) | undefined;
  try {
    // Persist ownership before writing bytes, so a later start can clean up a
    // crashed receive without scanning or deleting unrelated download files.
    forget = await trackStaging(temp);
    const handle = await fs.open(staged, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of request) {
        valid();
        bytes += chunk.length;
        if (bytes > offer.bytes || bytes > shareFileLimit)
          throw new Error("파일 크기가 승인 내용과 다릅니다.");
        if (head.length < 4096)
          head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
        hash.update(chunk);
        await handle.writeFile(chunk);
        progress(bytes);
      }
      if (bytes !== offer.bytes || hash.digest("hex") !== offer.hash)
        throw new Error("파일 무결성 검사에 실패했습니다.");
      validateSignature(name, head);
      await handle.sync();
    } finally {
      await handle.close();
    }
    valid();
    await protect(staged);
    // OS attachment services may remove or modify a file. Verify again before
    // publishing the protected inode. A hard link fails rather than overwriting.
    const check = createHash("sha256");
    for await (const chunk of createReadStream(staged)) check.update(chunk);
    if (check.digest("hex") !== offer.hash)
      throw new Error("운영체제 파일 검사 후 내용이 변경되었습니다.");
    valid();
    if ((await fs.realpath(directory)) !== root)
      throw new Error("다운로드 폴더가 변경되었습니다.");
    const ext = path.extname(name),
      stem = name.slice(0, -ext.length);
    for (let n = 0; n < 1000; n++) {
      const destination = path.join(root, n ? `${stem} (${n})${ext}` : name);
      try {
        await fs.link(staged, destination);
        final = destination;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!final) throw new Error("같은 이름의 파일이 너무 많습니다.");
    try {
      valid();
    } catch (error) {
      await fs.unlink(final);
      throw error;
    }
    return final;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
    forget?.();
  }
}
