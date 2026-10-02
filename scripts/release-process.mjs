import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Every release command has a deadline, and owns only its own process tree.
export async function runCommand(
  command,
  args,
  { cwd, env = process.env, log, timeout = 300000 } = {},
) {
  // Open the evidence file before launching a command. A path conflict or
  // permission error must never leave an unobserved build running.
  const output = log
    ? fs.createWriteStream(log, { fd: fs.openSync(log, "wx"), autoClose: true })
    : undefined;
  let child;
  let timer;
  let killer;
  let timedOut = false;
  let logError;
  const terminate = () => {
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const taskkill = spawn(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      taskkill.on("error", () => child.kill());
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      killer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }, 2000);
    }
  };
  const interrupt = () => {
    timedOut = true;
    terminate();
  };
  try {
    await new Promise((resolve, reject) => {
      output?.on("error", (error) => {
        logError = error;
        interrupt();
      });
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => {
          output?.write(data);
          process.stdout.write(data);
        });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (logError) reject(logError);
        else if (timedOut || code !== 0)
          reject(
            new Error(
              `${path.basename(command)} failed (${timedOut ? "timeout or interruption" : `exit ${code}, signal ${signal}`})`,
            ),
          );
        else resolve();
      });
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout);
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
    });
  } finally {
    clearTimeout(timer);
    // Keep the final tree kill scheduled after timeout even if the parent exits.
    if (!timedOut) clearTimeout(killer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (output && !output.destroyed)
      await new Promise((resolve) => output.end(resolve));
  }
}
