import { execFile } from "node:child_process";

export type DownloadRunner = (
  file: string,
  args: string[],
  input?: string,
) => Promise<string>;
export const runDownloadCommand: DownloadRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: 60000, maxBuffer: 65536, windowsHide: true, encoding: "utf8" },
      (error, stdout) =>
        error
          ? reject(new Error("운영체제의 다운로드 보호를 적용하지 못했습니다."))
          : resolve(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
