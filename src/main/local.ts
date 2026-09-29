import * as pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppEvent, LocalShell, Bootstrap } from "../shared/model";
export function shellPaths(): Map<LocalShell["shell"], string> {
  const entries: [LocalShell["shell"], string][] =
    process.platform === "win32"
      ? [
          [
            "powershell",
            path.join(
              process.env.ProgramFiles || "C:\\Program Files",
              "PowerShell",
              "7",
              "pwsh.exe",
            ),
          ],
          [
            "powershell",
            path.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
          ],
          [
            "cmd",
            path.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "cmd.exe",
            ),
          ],
        ]
      : [
          ["default", process.env.SHELL || "/bin/zsh"],
          ["zsh", "/bin/zsh"],
          ["bash", "/bin/bash"],
        ];
  const found = new Map<LocalShell["shell"], string>();
  for (const [key, file] of entries)
    if (fs.existsSync(file) && !found.has(key)) found.set(key, file);
  if (!found.has("default") && found.size)
    found.set(
      "default",
      found.get("powershell") || found.values().next().value!,
    );
  return found;
}
export function availableShells(): Bootstrap["shells"] {
  return [...shellPaths().keys()].map((id) => ({
    id,
    name: {
      default: "기본 로그인 셸",
      zsh: "zsh",
      bash: "bash",
      powershell: "PowerShell",
      cmd: "명령 프롬프트",
    }[id],
  }));
}
type LocalSession = {
  pty: pty.IPty;
  inFlight: number;
  queue: string;
  alive: boolean;
  dataListener: pty.IDisposable;
  timer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
};
export class LocalSessions {
  // A closed tab may still own a native exit callback. Keep tracking that
  // callback until it has returned, even after the tab leaves sessions.
  private pendingExits = new Set<Promise<void>>();
  private shuttingDown = false;
  sessions = new Map<string, LocalSession>();
  constructor(readonly emit: (e: AppEvent) => void) {}
  open(id: string, config: LocalShell) {
    if (this.shuttingDown) throw new Error("앱을 종료하고 있습니다.");
    this.close(id);
    const executable = shellPaths().get(config.shell);
    if (!executable)
      throw new Error("이 기기에 해당 셸이 설치되어 있지 않습니다.");
    const cwd = config.cwd || os.homedir();
    if (!fs.statSync(cwd).isDirectory())
      throw new Error("시작 폴더를 찾을 수 없습니다.");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      TERM_PROGRAM: "Passport",
    };
    // Do not reuse the parent Terminal.app's shell-session restoration ID.
    delete env.TERM_SESSION_ID;
    const terminal = pty.spawn(
      executable,
      process.platform === "win32"
        ? path.basename(executable).toLowerCase() === "cmd.exe"
          ? []
          : ["-NoLogo"]
        : ["-l"],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env,
      },
    );
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.pendingExits.add(exited);
    const entry: LocalSession = {
      pty: terminal,
      inFlight: 0,
      queue: "",
      alive: true,
      dataListener: { dispose() {} },
    };
    this.sessions.set(id, entry);
    entry.dataListener = terminal.onData((data) => {
      if (this.sessions.get(id) !== entry) return;
      entry.queue += data;
      if (Buffer.byteLength(entry.queue) + entry.inFlight >= 262144)
        terminal.pause();
      this.flush(id);
    });
    terminal.onExit(() => {
      entry.alive = false;
      clearTimeout(entry.killTimer);
      entry.dataListener.dispose();
      // Defer resolution past the JS/native callback stack. Electron must not
      // tear down its Node environment from inside node-pty's callback.
      setImmediate(() => {
        this.pendingExits.delete(exited);
        resolveExit();
      });
      if (this.sessions.get(id) === entry) {
        this.flush(id);
        this.emit({ kind: "session", state: { id, status: "disconnected" } });
      }
    });
    this.emit({ kind: "session", state: { id, status: "connected" } });
  }
  private flush(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (this.sessions.get(id) !== s) return;
      if (!s.queue || s.inFlight >= 262144) return;
      const data = s.queue.slice(0, 32768);
      s.queue = s.queue.slice(data.length);
      const bytes = Buffer.byteLength(data);
      s.inFlight += bytes;
      this.emit({ kind: "output", id, data, bytes });
      if (s.queue) this.flush(id);
    }, 8);
  }
  input(id: string, data: string) {
    const s = this.sessions.get(id);
    if (!s?.alive) throw new Error("로컬 터미널이 종료되었습니다.");
    s.pty.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (s?.alive) s.pty.resize(cols, rows);
  }
  ack(id: string, bytes: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - bytes);
    if (s.alive && s.inFlight + Buffer.byteLength(s.queue) < 131072)
      s.pty.resume();
    this.flush(id);
  }
  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    clearTimeout(s.timer);
    s.dataListener.dispose();
    s.queue = "";
    if (s.alive) {
      // Drain paused PTYs so node-pty can deliver its exit notification.
      s.pty.resume();
      s.pty.kill();
      if (s.alive)
        s.killTimer = setTimeout(() => {
          if (s.alive) s.pty.kill("SIGKILL");
        }, 1000);
      this.emit({ kind: "session", state: { id, status: "disconnected" } });
    }
  }
  closeAll() {
    for (const id of this.sessions.keys()) this.close(id);
  }
  async shutdown() {
    this.shuttingDown = true;
    this.closeAll();
    await Promise.all(this.pendingExits);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
