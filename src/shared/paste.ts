import type { ShellId } from "./terminal-config";

export type TerminalClipboard =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "files"; paths: string[]; text: string }
  | { kind: "image"; path: string; text: string };

// Quote paths for the shell that opened this session, never for a guessed CLI.
export function quotePastePaths(paths: string[], shell: ShellId): string {
  return paths
    .map((original) => {
      if (!original || /[\x00-\x1f\x7f]/.test(original))
        throw new Error("제어 문자가 포함된 파일 경로는 붙여넣을 수 없습니다.");
      const file =
        shell === "passport-bash" ? original.replace(/\\/g, "/") : original;
      if (shell === "cmd") {
        // Percent expansion and delayed expansion happen even inside double quotes.
        if (/["%!]/.test(file))
          throw new Error(
            "cmd에서 따옴표·%·!가 포함된 경로는 안전하게 붙여넣을 수 없습니다. PowerShell을 사용하세요.",
          );
        return `"${file}"`;
      }
      if (["powershell", "windows-powershell", "pwsh"].includes(shell))
        return `'${file.replace(/'/g, "''")}'`;
      if (!["zsh", "bash", "passport-bash"].includes(shell))
        throw new Error("이 셸의 파일 경로 붙여넣기를 지원하지 않습니다.");
      return `'${file.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

// Start reading immediately to capture each gesture's clipboard. Deliver in order.
export class PasteQueue {
  private tail = Promise.resolve();
  enqueue<T>(
    read: () => Promise<T>,
    valid: () => boolean,
    deliver: (value: T) => void,
    fail: (error: unknown) => void,
  ) {
    const captured = Promise.resolve()
      .then(read)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    this.tail = this.tail
      .then(async () => {
        const result = await captured;
        if (!valid()) return;
        if (result.ok) deliver(result.value);
        else fail(result.error);
      })
      .catch(fail);
    return this.tail;
  }
}
