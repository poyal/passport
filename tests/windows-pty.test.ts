import { test, expect } from "vitest";
import * as pty from "node-pty";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Read-only audit: never terminate processes by name or reused PID.
function consoles() {
  const rows = JSON.parse(
    execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='OpenConsole.exe'\" | Select-Object ProcessId,CreationDate,ExecutablePath)",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    ),
  ) as { ProcessId: number; CreationDate: string; ExecutablePath: string }[];
  const root = path.resolve("node_modules/node-pty").toLowerCase() + path.sep;
  return rows.filter((row) =>
    row.ExecutablePath?.toLowerCase().startsWith(root),
  );
}
const identity = (row: { ProcessId: number; CreationDate: string }) =>
  `${row.ProcessId}:${row.CreationDate}`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

test.skipIf(process.platform !== "win32")(
  "closing one Windows PTY terminates its child and preserves a different PTY",
  async () => {
    const terminals: pty.IPty[] = [];
    const children: number[] = [];
    const exits: Promise<{ exitCode: number; signal?: number }>[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const terminal = pty.spawn(
          path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-Command",
            "$child = Start-Process -NoNewWindow -FilePath $env:ComSpec -ArgumentList '/d','/c','ping -n 30 127.0.0.1 >nul' -PassThru; Write-Output ('PASSPORT_CHILD=' + $child.Id)",
          ],
          { useConptyDll: true, cols: 100, rows: 30, env: process.env },
        );
        terminals.push(terminal);
        exits.push(new Promise((resolve) => terminal.onExit(resolve)));
        let output = "";
        terminal.onData((data) => {
          output += data;
          if (data.includes("\x1b[c")) terminal.write("\x1b[?1;2c");
        });
        await expect
          .poll(() => output, { timeout: 5000 })
          .toMatch(/PASSPORT_CHILD=(\d+)/);
        children.push(Number(output.match(/PASSPORT_CHILD=(\d+)/)![1]));
      }
      terminals[0].kill();
      expect((await exits[0]).exitCode).toBeTypeOf("number");
      await expect.poll(() => alive(children[0])).toBe(false);
      expect(alive(terminals[1].pid)).toBe(true);
      expect(alive(children[1])).toBe(true);
      terminals[1].kill();
      expect((await exits[1]).exitCode).toBeTypeOf("number");
      await expect.poll(() => alive(children[1])).toBe(false);
    } finally {
      for (const terminal of terminals) terminal.kill();
    }
  },
  20000,
);

test.skipIf(process.platform !== "win32")(
  "Windows PTYs close their console when the initial shell exits before kill",
  async () => {
    const before = new Set(consoles().map(identity));
    const terminals: pty.IPty[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const terminal = pty.spawn(
          path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32/cmd.exe",
          ),
          ["/d", "/q"],
          { useConptyDll: true, cols: 80, rows: 24, env: process.env },
        );
        terminals.push(terminal);
        let output = "";
        terminal.onData((data) => {
          output += data;
          if (data.includes("\x1b[c")) terminal.write("\x1b[?1;2c");
        });
        await delay(200);
        expect(
          consoles().filter((row) => !before.has(identity(row))).length,
        ).toBeGreaterThan(0);
        terminal.write(
          'start "" /b cmd /d /c "ping -n 20 127.0.0.1 >nul" & echo PTY_EXIT_RACE_READY & exit\r',
        );
        await expect
          .poll(() => output, { timeout: 5000 })
          .toContain("PTY_EXIT_RACE_READY");
        // The root shell has exited; its attached child still owns the console.
        await expect
          .poll(
            () => {
              try {
                process.kill(terminal.pid, 0);
                return false;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH")
                  return true;
                throw error;
              }
            },
            { timeout: 5000 },
          )
          .toBe(true);
        await delay(100);
        terminal.kill();
      }
      await expect
        .poll(() => consoles().filter((row) => !before.has(identity(row))), {
          timeout: 6000,
          interval: 250,
        })
        .toEqual([]);
    } finally {
      for (const terminal of terminals) terminal.kill();
    }
  },
  30000,
);
