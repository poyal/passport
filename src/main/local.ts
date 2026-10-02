import * as pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppEvent, LocalShell } from "../shared/model";
import { shellPaths } from "./shells";
export { shellPaths, availableShells } from "./shells";
import type { LaunchSpec } from "./startup";
import { bashPromptMarkers } from "./startup";
import { localTerminalEnv } from "./terminal-env";
type LocalSession = {
  pty: pty.IPty;
  inFlight: number;
  queue: string;
  alive: boolean;
  dataListener: pty.IDisposable;
  timer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  launch?: LaunchSpec;
  startupTimer?: ReturnType<typeof setTimeout>;
  bashPrompt?: boolean;
  bashProtocolTail?: string;
  primeBashInput?: boolean;
};
export class LocalSessions {
  // A closed tab may still own a native exit callback. Keep tracking that
  // callback until it has returned, even after the tab leaves sessions.
  private pendingExits = new Set<Promise<void>>();
  private shuttingDown = false;
  sessions = new Map<string, LocalSession>();
  constructor(readonly emit: (e: AppEvent) => void) {}
  open(id: string, config: LocalShell, launch?: LaunchSpec) {
    if (this.shuttingDown) throw new Error("앱을 종료하고 있습니다.");
    this.close(id);
    const executable = launch?.executable || shellPaths().get(config.shell);
    if (!executable)
      throw new Error("이 기기에 해당 셸이 설치되어 있지 않습니다.");
    const cwd = launch?.cwd || config.cwd || os.homedir();
    if (!fs.statSync(cwd).isDirectory())
      throw new Error("시작 폴더를 찾을 수 없습니다.");
    const terminal = pty.spawn(
      executable,
      launch?.args ??
        (process.platform === "win32"
          ? path.basename(executable).toLowerCase() === "cmd.exe"
            ? []
            : ["-NoLogo"]
          : ["-l"]),
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: launch?.env || localTerminalEnv(),
        // Use the bundled ConPTY on Windows 11. The system ConPTY shutdown
        // forks a console-list helper that can race with the shell's exit.
        useConptyDll: process.platform === "win32",
      },
    );
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.pendingExits.add(exited);
    const entry: LocalSession = {
      pty: terminal,
      launch,
      inFlight: 0,
      queue: "",
      alive: true,
      dataListener: { dispose() {} },
    };
    this.sessions.set(id, entry);
    entry.dataListener = terminal.onData((data) => {
      if (this.sessions.get(id) !== entry) return;
      if (
        process.platform === "win32" &&
        launch?.snapshot.shell === "passport-bash"
      ) {
        const protocol = (entry.bashProtocolTail || "") + data;
        const markers = bashPromptMarkers(launch.snapshot.sessionInstanceId);
        const prompt = protocol.lastIndexOf(markers.prompt);
        const command = protocol.lastIndexOf(markers.command);
        if (prompt >= 0 || command >= 0) entry.bashPrompt = prompt > command;
        entry.bashProtocolTail = protocol.slice(-(markers.prompt.length - 1));
      }
      entry.queue += data;
      if (Buffer.byteLength(entry.queue) + entry.inFlight >= 262144)
        terminal.pause();
      this.flush(id);
    });
    terminal.onExit(() => {
      entry.alive = false;
      clearTimeout(entry.startupTimer);
      try {
        entry.launch?.cleanup();
      } catch {
        /* a locked loader is reclaimed on the next app start */
      }
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
    this.emit({
      kind: "session",
      state: { id, status: "connected", environment: launch?.snapshot },
    });
    if (launch && launch.snapshot.status === "starting")
      entry.startupTimer = setTimeout(() => {
        if (
          this.sessions.get(id) !== entry ||
          launch.snapshot.status !== "starting"
        )
          return;
        launch.snapshot.status = "failed";
        launch.snapshot.results.push(
          "초기화 완료 신호가 없습니다. 셸 시작 파일·실행 정책·프로파일 오류를 확인하세요.",
        );
        this.emit({
          kind: "session",
          state: { id, status: "connected", environment: launch.snapshot },
        });
      }, 15000);
  }
  ready(id: string, generation: string, result?: string) {
    const entry = this.sessions.get(id),
      snapshot = entry?.launch?.snapshot;
    if (!entry || !snapshot || snapshot.sessionInstanceId !== generation)
      return;
    if (result) {
      if (snapshot.results.length < 250) snapshot.results.push(result);
      if (result.startsWith("!error:")) {
        snapshot.status = "failed";
        clearTimeout(entry.startupTimer);
      }
    } else {
      snapshot.status = "ready";
      clearTimeout(entry.startupTimer);
    }
    this.emit({
      kind: "session",
      state: {
        id,
        status: "connected",
        environment: structuredClone(snapshot),
      },
    });
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
    if (
      s.primeBashInput &&
      s.bashPrompt &&
      data &&
      !["\x1b[I", "\x1b[O", "\x1b[?1;2c"].includes(data)
    ) {
      // NUL is Readline's non-printing set-mark command. It absorbs the stale
      // resize read instead of losing the user's first byte. Prompt markers
      // and Enter tracking keep this out of child CLI/TUI input.
      data = "\x00" + data;
      s.primeBashInput = false;
    }
    if (data.includes("\r") || data.includes("\n")) s.bashPrompt = false;
    s.pty.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (s?.alive) {
      if (s.pty.cols === cols && s.pty.rows === rows) return;
      s.pty.resize(cols, rows);
      if (
        process.platform === "win32" &&
        s.launch?.snapshot.shell === "passport-bash"
      )
        s.primeBashInput = true;
    }
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
    clearTimeout(s.startupTimer);
    s.dataListener.dispose();
    s.queue = "";
    if (s.alive) {
      // Drain paused PTYs so node-pty can deliver its exit notification.
      s.pty.resume();
      s.pty.kill();
      // Windows node-pty terminates the process itself and rejects POSIX signals.
      if (s.alive && process.platform !== "win32")
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
