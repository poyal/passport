import { randomUUID } from "node:crypto";
import { runDownloadCommand, type DownloadRunner } from "../shared/download";

export function createDarwinDownload(run: DownloadRunner = runDownloadCommand) {
  return async (file: string) => {
    const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Passport;${randomUUID()}`;
    await run("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, file]);
    const marked = await run("/usr/bin/xattr", [
      "-p",
      "com.apple.quarantine",
      file,
    ]);
    if (marked.trim() !== value)
      throw new Error("다운로드 보호 표시를 확인할 수 없습니다.");
  };
}
