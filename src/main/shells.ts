import fs from "node:fs";
import path from "node:path";
import type { ShellId, ShellInfo } from "../shared/terminal-config";
import { platform } from "./platform";

export const resourceRoot = () =>
  process.resourcesPath &&
  fs.existsSync(path.join(process.resourcesPath, "terminal"))
    ? path.join(process.resourcesPath, "terminal")
    : path.resolve("resources/terminal");
export const helperPath = () =>
  path.join(
    resourceRoot(),
    "helper",
    `${platform.id}-${process.arch}`,
    platform.terminal.helperName,
  );
export const bashPath = () =>
  platform.terminal.paths.join(
    resourceRoot(),
    "runtime",
    process.arch,
    "bin",
    "bash.exe",
  );
export const executableArchitecture = (file: string) =>
  platform.terminal.executableArchitecture(file);
export const availableShells = (): ShellInfo[] =>
  platform.terminal.shells(resourceRoot());
export const shellPaths = () =>
  new Map(
    availableShells()
      .filter((s) => s.available)
      .map((s) => [s.id, s.path]),
  );
export function resolvedShell(id: ShellId): ShellInfo {
  const shell = availableShells().find((s) => s.id === id);
  if (!shell?.available)
    throw new Error(shell?.reason || "이 OS에서 사용할 수 없는 셸입니다.");
  if (id === "default" || id === "powershell") {
    const basename = platform.terminal.paths
      .basename(shell.path)
      .replace(/\.exe$/i, "");
    const actual = (
      {
        zsh: "zsh",
        bash: "bash",
        pwsh: "pwsh",
        powershell: "windows-powershell",
        cmd: "cmd",
      } as const
    )[basename as "zsh"];
    if (actual) return { ...shell, id: actual };
  }
  return shell;
}
