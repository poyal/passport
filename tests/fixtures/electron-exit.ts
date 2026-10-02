import { expect, type ElectronApplication } from "@playwright/test";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import path from "node:path";

export async function closeCleanly(
  application: ElectronApplication,
  timeout = 10000,
) {
  const child = application.process();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve([child.exitCode, child.signalCode])
      : once(child, "exit");
  let stderr = "";
  const onStderr = (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4096);
  };
  child.stderr?.on("data", onStderr);
  let deadlineExpired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineExpired = true;
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (
          process.platform === "darwin" &&
          process.env.PASSPORT_SHUTDOWN_DIAGNOSTICS
        ) {
          try {
            execFileSync(
              "/usr/bin/sample",
              [
                String(child.pid),
                "1",
                "1",
                "-file",
                path.join(
                  process.env.PASSPORT_SHUTDOWN_DIAGNOSTICS,
                  `shutdown-${child.pid}.sample.txt`,
                ),
              ],
              { stdio: "ignore", timeout: 2000 },
            );
          } catch {
            /* diagnostic capture must not block cleanup */
          }
        }
        if (process.platform === "win32") {
          try {
            execFileSync(
              path.join(
                process.env.SystemRoot || "C:\\Windows",
                "System32/taskkill.exe",
              ),
              ["/PID", String(child.pid), "/T", "/F"],
              { stdio: "ignore", timeout: 3000 },
            );
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          // Only descendants of this isolated test app are eligible.
          try {
            const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
              encoding: "utf8",
              timeout: 1000,
            })
              .trim()
              .split("\n")
              .map((row) => row.trim().split(/\s+/).map(Number));
            const owned = new Set([child.pid]);
            for (let count = 0; count < rows.length; count++) {
              const previous = owned.size;
              for (const [pid, parent] of rows)
                if (owned.has(parent)) owned.add(pid);
              if (owned.size === previous) break;
            }
            for (const pid of [...owned].reverse()) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                /* already exited */
              }
            }
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      reject(
        new Error(
          `Electron normal shutdown exceeded ${timeout}ms; the isolated test process tree was terminated. ${stderr}`,
        ),
      );
    }, timeout);
  });
  try {
    await Promise.race([
      (async () => {
        let windowAudit:
          { mode: string; shown: number; focused: number } | undefined;
        if (child.exitCode === null && child.signalCode === null) {
          windowAudit = await application.evaluate(({ app, dialog }) => {
            if (process.env.PASSPORT_SHUTDOWN_DIAGNOSTICS) {
              for (const event of [
                "before-quit",
                "will-quit",
                "window-all-closed",
                "quit",
              ] as const)
                app.on(event as "quit", () =>
                  console.error(
                    "TEST_QUIT",
                    event,
                    process.getActiveResourcesInfo(),
                  ),
                );
            }
            // Teardown must also answer the live-connection close confirmation.
            dialog.showMessageBox = async () => ({
              response: 1,
              checkboxChecked: false,
            });
            // Preserve the established graceful quit path, including native
            // PTY cleanup. A timeout is a failure, never a successful close.
            setTimeout(() => app.quit(), 0);
            return (globalThis as any).__passportE2EWindowAudit;
          });
        }
        await exited;
        if (deadlineExpired) return;
        await application.close();
        const [code, signal] = await exited;
        if (deadlineExpired) return;
        expect(
          { code, signal },
          "Electron must exit normally, including native PTY teardown",
        ).toEqual({ code: 0, signal: null });
        if (windowAudit) {
          expect(
            windowAudit.focused,
            "Background E2E must never focus a native window",
          ).toBe(0);
          if (windowAudit.mode === "hidden")
            expect(
              windowAudit.shown,
              "Hidden E2E must never show a native window",
            ).toBe(0);
        }
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer!);
    child.stderr?.removeListener("data", onStderr);
  }
}
