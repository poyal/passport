import fs from "node:fs";
import path from "node:path";
import type { TerminalPlatform } from "../contracts";
import {
  bashPromptMarkers,
  describeShells,
  plainPtyBehavior,
} from "../shared/terminal";

export function windowsExecutableArchitecture(file: string): string {
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
      ({ 0x8664: "x64", 0x14c: "x86" } as Record<number, string>)[
        pe.readUInt16LE(4)
      ] || "unknown"
    );
  } catch {
    return "unknown";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function createWindowsTerminal(
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (file: string) => boolean;
    architecture?: (file: string) => string;
  } = {},
): TerminalPlatform {
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const architecture = options.architecture ?? windowsExecutableArchitecture;
  const bashPath = (root: string) =>
    path.win32.join(root, "runtime", "x64", "bin", "bash.exe");
  return {
    id: "win32",
    paths: path.win32,
    helperName: "passport-helper.exe",
    useConptyDll: true,
    executableArchitecture: architecture,
    shells(resourceRoot) {
      const root = env.SystemRoot || "C:\\Windows";
      const windowsPS = path.win32.join(
        root,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const pwsh = path.win32.join(
        env.ProgramFiles || "C:\\Program Files",
        "PowerShell/7/pwsh.exe",
      );
      return describeShells(
        [
          ["passport-bash", "Passport Bash (내장)", bashPath(resourceRoot)],
          [
            "cmd",
            "명령 프롬프트 (cmd)",
            path.win32.join(root, "System32/cmd.exe"),
          ],
          ["windows-powershell", "Windows PowerShell 5.1", windowsPS],
          ["pwsh", "PowerShell 7", pwsh],
          ["default", "기존 기본 셸", exists(pwsh) ? pwsh : windowsPS],
          [
            "powershell",
            "PowerShell (기존 선택)",
            exists(pwsh) ? pwsh : windowsPS,
          ],
        ],
        exists,
        architecture,
      );
    },
    defaultArgs: (executable) =>
      path.win32.basename(executable).toLowerCase() === "cmd.exe"
        ? []
        : ["-NoLogo"],
    posixPath: (file) =>
      file
        .replace(/\\/g, "/")
        .replace(
          /^([A-Za-z]):/,
          (_, drive: string) => `/${drive.toLowerCase()}`,
        ),
    profileKey: (name) => name.toLowerCase(),
    configureEnvironment(target, snapshot, root) {
      const bash = bashPath(root);
      if (exists(bash) && !target.CLAUDE_CODE_GIT_BASH_PATH)
        target.CLAUDE_CODE_GIT_BASH_PATH = bash;
      if (snapshot.shell === "passport-bash") {
        target.MSYSTEM = "MINGW64";
        target.CHERE_INVOKING = "1";
        target.PROMPT_COMMAND = `${target.PROMPT_COMMAND ? target.PROMPT_COMMAND + "; " : ""}printf '\\033]133;A;passport=${snapshot.sessionInstanceId}\\007'`;
        target.PS0 =
          bashPromptMarkers(snapshot.sessionInstanceId).command +
          (target.PS0 || "");
      }
    },
    createPtyBehavior(snapshot) {
      if (snapshot?.shell !== "passport-bash") return plainPtyBehavior();
      const markers = bashPromptMarkers(snapshot.sessionInstanceId);
      let tail = "",
        prompt = false,
        prime = false;
      return {
        ...plainPtyBehavior(),
        observeOutput(data) {
          const protocol = tail + data;
          const start = protocol.lastIndexOf(markers.prompt);
          const command = protocol.lastIndexOf(markers.command);
          if (start >= 0 || command >= 0) prompt = start > command;
          tail = protocol.slice(-(markers.prompt.length - 1));
        },
        input(data) {
          // Readline consumes the resize event; never prime input to a child TUI.
          if (
            prime &&
            prompt &&
            data &&
            !["\x1b[I", "\x1b[O", "\x1b[?1;2c"].includes(data)
          ) {
            data = "\x00" + data;
            prime = false;
          }
          if (data.includes("\r") || data.includes("\n")) prompt = false;
          return data;
        },
        resized() {
          prime = true;
        },
      };
    },
  };
}
