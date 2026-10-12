import type { ShellId } from "../shared/terminal-config";
import { quotePastePaths } from "../shared/paste";
import { validateFilePaths } from "./clipboard-files";

/** Like file clipboard paste, pass original paths without opening or copying their contents. */
export async function prepareTerminalDrop(options: {
  paths: string[];
  platform: string;
  shell: ShellId;
  check: () => void;
}): Promise<string> {
  options.check();
  let paths: string[];
  try {
    paths = validateFilePaths(options.paths, options.platform);
    if (!paths.length) throw new Error();
  } catch {
    throw new Error(
      "드롭한 파일의 전체 경로를 읽을 수 없거나 경로 제한을 초과했습니다.",
    );
  }
  const text = ` ${quotePastePaths(paths, options.shell)} `;
  // Reserve the bracketed-paste delimiters in the existing session.input limit.
  if (Buffer.byteLength(text, "utf8") > 262144 - 12)
    throw new Error("파일 경로가 너무 깁니다. 항목을 나누어 드롭하세요.");
  options.check();
  return text;
}
