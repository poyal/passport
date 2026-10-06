import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const identity = (row) => `${row.ProcessId}:${row.CreationDate}`;

export function ptyAuditRoots(root, executable) {
  const resources = executable
    ? path.win32.join(path.win32.dirname(executable), "resources")
    : path.win32.join(root, "resources");
  return [
    executable
      ? path.win32.join(resources, "app.asar.unpacked/node_modules/node-pty")
      : path.win32.join(root, "node_modules/node-pty"),
    path.win32.join(resources, "terminal/runtime"),
  ].map((directory) => path.win32.resolve(directory).toLowerCase() + "\\");
}

export function newPtyProcesses(rows, roots, before) {
  const previous = new Set(before.map(identity));
  return rows.filter(
    (row) =>
      row.ExecutablePath &&
      roots.some((root) =>
        path.win32.normalize(row.ExecutablePath).toLowerCase().startsWith(root),
      ) &&
      !previous.has(identity(row)),
  );
}

async function processes() {
  const { stdout } = await execute(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate,ExecutablePath)",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

// Audit only: no process is killed and no user installation is replaced.
export async function beginWindowsPtyAudit(root, executable) {
  if (process.platform !== "win32") return null;
  const roots = ptyAuditRoots(root, executable);
  const before = await processes();
  return async () => {
    const deadline = Date.now() + 5000;
    let residual;
    do {
      residual = newPtyProcesses(await processes(), roots, before);
      if (!residual.length) break;
      await delay(250);
    } while (Date.now() < deadline);
    return { roots, residual, passed: residual.length === 0 };
  };
}
