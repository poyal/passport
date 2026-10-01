import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { ShellId, ShellInfo } from "../shared/terminal-config";

export const resourceRoot = () =>
  process.resourcesPath &&
  fs.existsSync(path.join(process.resourcesPath, "terminal"))
    ? path.join(process.resourcesPath, "terminal")
    : path.resolve("resources/terminal");
export const helperPath = () =>
  path.join(
    resourceRoot(),
    "helper",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "passport-helper.exe" : "passport-helper",
  );
export const bashPath = () =>
  path.join(resourceRoot(), "runtime", process.arch, "bin", "bash.exe");
let loginShell: string | undefined;
export function executableArchitecture(file: string): string {
  if (process.platform !== "win32") return process.arch;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    if (header.toString("ascii", 0, 2) !== "MZ") return "unknown";
    const pe = Buffer.alloc(6);
    fs.readSync(fd, pe, 0, 6, header.readUInt32LE(60));
    if (pe.readUInt32LE(0) !== 0x4550) return "unknown";
    return (
      (
        { 0xaa64: "arm64", 0x8664: "x64", 0x14c: "x86" } as Record<
          number,
          string
        >
      )[pe.readUInt16LE(4)] || "unknown"
    );
  } catch {
    return "unknown";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function defaultShell() {
  if (loginShell) return loginShell;
  try {
    loginShell = os.userInfo().shell || undefined;
  } catch {
    /* unavailable account database */
  }
  if (!loginShell && process.platform === "darwin") {
    try {
      loginShell = execFileSync(
        "/usr/bin/dscl",
        [".", "-read", `/Users/${os.userInfo().username}`, "UserShell"],
        { encoding: "utf8", timeout: 1000 },
      )
        .trim()
        .replace(/^UserShell:\s*/, "");
    } catch {
      /* fallback */
    }
  }
  return (loginShell ||= process.env.SHELL || "/bin/zsh");
}
export function availableShells(): ShellInfo[] {
  const root = process.env.SystemRoot || "C:\\Windows";
  const windowsPS = path.join(
    root,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const pwsh = path.join(
    process.env.ProgramFiles || "C:\\Program Files",
    "PowerShell/7/pwsh.exe",
  );
  const entries: [ShellId, string, string][] =
    process.platform === "win32"
      ? [
          ["passport-bash", "Passport Bash (내장)", bashPath()],
          ["cmd", "명령 프롬프트 (cmd)", path.join(root, "System32/cmd.exe")],
          ["windows-powershell", "Windows PowerShell 5.1", windowsPS],
          ["pwsh", "PowerShell 7", pwsh],
          ["default", "기존 기본 셸", fs.existsSync(pwsh) ? pwsh : windowsPS],
          [
            "powershell",
            "PowerShell (기존 선택)",
            fs.existsSync(pwsh) ? pwsh : windowsPS,
          ],
        ]
      : [
          ["default", "기본 로그인 셸", defaultShell()],
          ["zsh", "zsh", "/bin/zsh"],
          ["bash", "bash", "/bin/bash"],
        ];
  return entries.map(([id, name, executable]) => ({
    id,
    name,
    path: executable,
    architecture: executableArchitecture(executable),
    available: fs.existsSync(executable),
    ...(!fs.existsSync(executable)
      ? {
          reason:
            id === "passport-bash"
              ? "내장 런타임이 없습니다. 런타임 준비 후 다시 빌드하세요."
              : "이 기기에 설치되어 있지 않습니다.",
        }
      : {}),
  }));
}
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
    const basename = path.basename(shell.path).replace(/\.exe$/i, "");
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
