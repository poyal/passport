import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { TerminalPlatform } from "../contracts";
import { describeShells, plainPtyBehavior } from "../shared/terminal";

export function createDarwinTerminal(
  options: {
    arch?: string;
    env?: NodeJS.ProcessEnv;
    exists?: (file: string) => boolean;
    loginShell?: () => string | undefined;
  } = {},
): TerminalPlatform {
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  let loginShell: string | undefined;
  const resolveLoginShell =
    options.loginShell ??
    (() => {
      let value: string | undefined;
      try {
        value = os.userInfo().shell || undefined;
      } catch {
        /* account unavailable */
      }
      if (!value) {
        try {
          value = execFileSync(
            "/usr/bin/dscl",
            [".", "-read", `/Users/${os.userInfo().username}`, "UserShell"],
            { encoding: "utf8", timeout: 1000 },
          )
            .trim()
            .replace(/^UserShell:\s*/, "");
        } catch {
          /* use environment fallback */
        }
      }
      return value;
    });
  return {
    id: "darwin",
    paths: path.posix,
    helperName: "passport-helper",
    useConptyDll: false,
    executableArchitecture: () => arch,
    shells: () =>
      describeShells(
        [
          [
            "default",
            "기본 로그인 셸",
            (loginShell ||= resolveLoginShell() || env.SHELL || "/bin/zsh"),
          ],
          ["zsh", "zsh", "/bin/zsh"],
          ["bash", "bash", "/bin/bash"],
        ],
        exists,
        () => arch,
      ),
    defaultArgs: () => ["-l"],
    posixPath: (file) => file,
    profileKey: (name) => name,
    configureEnvironment() {},
    createPtyBehavior() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        ...plainPtyBehavior(),
        terminate(pty, alive) {
          pty.kill();
          if (alive())
            timer = setTimeout(() => {
              if (alive()) pty.kill("SIGKILL");
            }, 1000);
        },
        dispose() {
          clearTimeout(timer);
        },
      };
    },
  };
}
