import { prepareRemoteResume, ResumeOutput } from "./ssh-resume";
import { detectRemoteOS } from "./remote-os";
import { Client, type ClientChannel, type Algorithms } from "ssh2";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AppEvent, Host, Secret } from "../shared/model";
import type { Store } from "./store";
import { TerminalInputQueue } from "./terminal-input";
import { terminalOutputChunk } from "./terminal-output";

export type TrustPrompt = (host: Host, fingerprint: string) => Promise<boolean>;
const sshAlgorithms: Algorithms = {
  kex: {
    // Keep modern algorithms first while allowing legacy-only servers.
    append: [
      "diffie-hellman-group14-sha1",
      "diffie-hellman-group-exchange-sha1",
      "diffie-hellman-group1-sha1",
    ],
    prepend: [],
    remove: [],
  },
};
export function connectSSH(
  host: Host,
  secret: Secret,
  store: Store,
  confirm: TrustPrompt,
  signal?: AbortSignal,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let ready = false,
      ended = false,
      rejection = "";
    const abort = () => {
      ended = true;
      client.destroy();
      reject(new Error("연결을 취소했습니다."));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    client.once("ready", () => {
      ready = true;
      resolve(client);
    });
    client.on("error", (error) => {
      if (!ready) {
        const message = /no matching key exchange algorithm/i.test(
          error.message,
        )
          ? "서버와 공통 키 교환 방식이 없습니다. 구형 방식까지 지원하지만 서버가 제공하는 방식과 일치하지 않습니다. 서버의 SSH 설정을 확인하거나 업데이트하세요."
          : error.message;
        reject(new Error(rejection || `SSH 연결 실패: ${message}`));
      }
    });
    client.once("close", () => {
      ended = true;
      signal?.removeEventListener("abort", abort);
      if (!ready) reject(new Error(rejection || "SSH 연결이 종료되었습니다."));
    });
    client.connect({
      host: host.address,
      port: host.port,
      username: host.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      algorithms: sshAlgorithms,
      ...(secret.type === "key"
        ? {
            privateKey: secret.privateKey,
            passphrase: secret.passphrase || undefined,
          }
        : { password: secret.password }),
      tryKeyboard: false,
      hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
        const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
        const known = store.fingerprint(host.address, host.port);
        if (known) {
          if (known !== fingerprint)
            rejection = "호스트 키가 변경되었습니다. 연결을 차단했습니다.";
          callback(known === fingerprint);
          return;
        }
        if (!store.read().settings.confirmNewHostKeys) {
          store.trust(host.address, host.port, fingerprint);
          callback(true);
          return;
        }
        void confirm(host, fingerprint)
          .then((accepted) => {
            if (ended || signal?.aborted) {
              callback(false);
              return;
            }
            if (accepted) store.trust(host.address, host.port, fingerprint);
            else rejection = "호스트 키 등록을 취소했습니다.";
            callback(accepted);
          })
          .catch(() => callback(false));
      },
    });
  });
}
type Session = {
  id: string;
  generation: string;
  host: Host;
  secret: Secret;
  controller: AbortController;
  client?: Client;
  stream?: ClientChannel;
  decoder: StringDecoder;
  stderrDecoder: StringDecoder;
  queue: string;
  inFlight: number;
  flush?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  intentional: boolean;
  status: string;
  cols: number;
  rows: number;
  filter?: ResumeOutput;
  cleanup?: () => Promise<void>;
  readyTimer?: ReturnType<typeof setTimeout>;
  inputQueue?: TerminalInputQueue;
};
export class Sessions {
  readonly sessions = new Map<string, Session>();
  constructor(
    readonly store: Store,
    readonly confirm: TrustPrompt,
    readonly emit: (event: AppEvent) => void,
    readonly onDetectedOS?: (host: Host, os: string) => void,
    readonly resume?: {
      enabled: () => boolean;
      begin: (id: string, generation: string) => void;
      cwd: (id: string, cwd: string) => void;
      previousCwd: (id: string, host: Host) => string | undefined;
      hydrate?: (id: string, host: Host) => Promise<void>;
      notice: (id: string, message: string) => void;
    },
  ) {}
  async open(id: string, host: Host, secret: Secret, startup?: string) {
    if (host.protocol !== "ssh")
      throw new Error("SSH 호스트만 터미널에 연결할 수 있습니다.");
    if (this.sessions.has(id)) this.close(id);
    if (this.sessions.size >= 32)
      throw new Error("최대 32개 SSH 세션을 열 수 있습니다.");
    const s: Session = {
      id,
      generation: randomUUID(),
      host,
      secret,
      controller: new AbortController(),
      decoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      queue: "",
      inFlight: 0,
      attempts: 0,
      intentional: false,
      status: "connecting",
      cols: 100,
      rows: 30,
    };
    this.sessions.set(id, s);
    await this.connect(s, startup);
  }
  private status(
    s: Session,
    status: "connecting" | "connected" | "disconnected" | "error",
    message?: string,
  ) {
    s.status = status;
    this.emit({
      kind: "session",
      state: { id: s.id, generation: s.generation, status, message },
    });
  }
  private async connect(s: Session, startup?: string) {
    if (s.intentional) return;
    s.inputQueue?.dispose();
    clearTimeout(s.flush);
    s.flush = undefined;
    s.queue = "";
    s.inFlight = 0;
    const generation = (s.generation = randomUUID());
    this.resume?.begin(s.id, generation);
    this.status(
      s,
      "connecting",
      s.attempts ? `재접속 ${s.attempts}/3` : undefined,
    );
    try {
      const client = await connectSSH(
        s.host,
        s.secret,
        this.store,
        this.confirm,
        s.controller.signal,
      );
      if (s.intentional || s.generation !== generation) {
        client.end();
        return;
      }
      s.client = client;
      if (this.resume?.enabled() && s.attempts === 0)
        await this.resume.hydrate?.(s.id, s.host);
      let prepared: Awaited<ReturnType<typeof prepareRemoteResume>> | undefined;
      if (this.resume?.enabled()) {
        try {
          prepared = await prepareRemoteResume(
            client,
            this.resume.previousCwd(s.id, s.host),
          );
        } catch (error) {
          this.resume.notice(
            s.id,
            error instanceof Error
              ? error.message
              : "SSH 작업 폴더 복원을 준비하지 못했습니다.",
          );
        }
      }
      if (s.intentional || s.generation !== generation) {
        await prepared?.cleanup();
        client.end();
        return;
      }
      let ready = false;
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        const callback = (err: Error | undefined, channel: ClientChannel) =>
          err ? reject(err) : resolve(channel);
        if (prepared)
          client.exec(
            prepared.command,
            {
              pty: { term: "xterm-256color", cols: s.cols, rows: s.rows },
              env: s.host.environment,
            },
            callback,
          );
        else
          client.shell(
            { term: "xterm-256color", cols: s.cols, rows: s.rows },
            { env: s.host.environment },
            callback,
          );
      });
      if (s.intentional || s.generation !== generation) {
        await prepared?.cleanup();
        stream.close();
        client.end();
        return;
      }
      s.cleanup = prepared?.cleanup;
      s.filter = prepared
        ? new ResumeOutput(prepared.nonce, (kind, value) => {
            if (
              s.intentional ||
              s.generation !== generation ||
              s.client !== client
            )
              return;
            if (kind === "cwd") this.resume?.cwd(s.id, value);
            if (kind === "warning") this.resume?.notice(s.id, value);
            if (kind === "ready" && !ready) {
              ready = true;
              clearTimeout(s.readyTimer);
              if (startup) s.inputQueue?.input(startup + "\r");
              void prepared?.cleanup();
            }
          })
        : undefined;
      if (prepared)
        s.readyTimer = setTimeout(() => {
          if (!ready && !s.intentional && s.generation === generation)
            this.resume?.notice(
              s.id,
              "SSH 셸 준비 신호가 없어 시작 스니펫을 실행하지 않았습니다. 서버 시작 설정을 확인하세요.",
            );
        }, 5000);
      s.stream = stream;
      s.inputQueue = new TerminalInputQueue(
        s.id,
        (data, done) => {
          if (
            s.stream !== stream ||
            s.generation !== generation ||
            s.intentional ||
            s.status !== "connected"
          ) {
            done(new Error("SSH 터미널 연결이 변경되었습니다."));
            return;
          }
          stream.write(data, done);
        },
        this.emit,
        (error) => {
          if (
            s.stream !== stream ||
            s.generation !== generation ||
            s.intentional
          )
            return;
          this.close(s.id);
          this.status(
            s,
            "error",
            `터미널 입력 전송에 실패했습니다: ${error.message}`,
          );
        },
      );
      this.status(s, "connected");
      if (this.onDetectedOS)
        void detectRemoteOS(client)
          .then((os) => {
            if (
              os &&
              !s.intentional &&
              s.generation === generation &&
              s.client === client
            )
              this.onDetectedOS?.(s.host, os);
          })
          .catch(() => {});
      stream.on("data", (data: Buffer) => {
        if (s.stream !== stream || s.generation !== generation || s.intentional)
          return;
        const decoded = s.decoder.write(data);
        s.queue += s.filter ? s.filter.push(decoded) : decoded;
        if (s.inFlight + Buffer.byteLength(s.queue) >= 256 * 1024) {
          stream.pause();
          stream.stderr.pause();
        }
        this.schedule(s);
      });
      stream.stderr.on("data", (data: Buffer) => {
        if (s.stream !== stream || s.generation !== generation || s.intentional)
          return;
        const decoded = s.stderrDecoder.write(data);
        s.queue += s.filter ? s.filter.push(decoded) : decoded;
        if (s.inFlight + Buffer.byteLength(s.queue) >= 256 * 1024) {
          stream.pause();
          stream.stderr.pause();
        }
        this.schedule(s);
      });
      stream.once("close", () => {
        if (s.stream !== stream || s.generation !== generation) return;
        s.inputQueue?.dispose();
        const tail = s.decoder.end() + s.stderrDecoder.end();
        s.queue += s.filter ? s.filter.push(tail) + s.filter.end() : tail;
        clearTimeout(s.readyTimer);
        void s.cleanup?.();
        clearTimeout(s.flush);
        s.flush = undefined;
        // Closing streams can leave more than one ACK's IPC limit queued.
        // Preserve the normal Unicode-safe chunk boundary while draining.
        while (s.queue && !s.intentional) {
          const data = terminalOutputChunk(s.queue);
          s.queue = s.queue.slice(data.length);
          const bytes = Buffer.byteLength(data);
          s.inFlight += bytes;
          this.emit({ kind: "output", id: s.id, generation, data, bytes });
        }
        client.end();
      });
      if (startup && !prepared) s.inputQueue.input(startup + "\r");
      client.once("close", () => {
        if (s.client === client && s.generation === generation)
          this.disconnected(s);
      });
      client.on("error", (error) => {
        if (
          !s.intentional &&
          s.generation === generation &&
          s.client === client
        ) {
          s.inputQueue?.dispose();
          this.status(s, "error", `SSH 연결 오류: ${error.message}`);
        }
      });
    } catch (error) {
      if (s.intentional || s.generation !== generation) return;
      const message =
        error instanceof Error ? error.message : "SSH 연결에 실패했습니다.";
      this.status(s, "error", message);
      if (!/auth|인증|키|password|private|passphrase/i.test(message))
        this.reconnect(s);
    }
  }
  private disconnected(s: Session) {
    if (s.intentional) return;
    s.inputQueue?.dispose();
    this.status(s, "disconnected", "연결이 종료되었습니다.");
    this.reconnect(s);
  }
  private reconnect(s: Session) {
    if (!s.host.autoReconnect || s.intentional || s.attempts >= 3 || s.retry)
      return;
    const delay = [1000, 2000, 5000][s.attempts++];
    s.retry = setTimeout(() => {
      s.retry = undefined;
      s.decoder = new StringDecoder("utf8");
      s.stderrDecoder = new StringDecoder("utf8");
      void this.connect(s);
    }, delay);
  }
  private schedule(s: Session) {
    if (!s.flush)
      s.flush = setTimeout(() => {
        s.flush = undefined;
        if (s.intentional || !s.queue || s.inFlight >= 256 * 1024) return;
        const data = terminalOutputChunk(s.queue);
        s.queue = s.queue.slice(data.length);
        const bytes = Buffer.byteLength(data);
        s.inFlight += bytes;
        this.emit({
          kind: "output",
          id: s.id,
          generation: s.generation,
          data,
          bytes,
        });
        if (s.queue) this.schedule(s);
      }, 8);
  }
  ack(id: string, bytes: number, generation?: string) {
    const s = this.sessions.get(id);
    if (!s || (generation !== undefined && s.generation !== generation)) return;
    s.inFlight = Math.max(0, s.inFlight - bytes);
    if (s.inFlight + Buffer.byteLength(s.queue) < 128 * 1024) {
      s.stream?.resume();
      s.stream?.stderr.resume();
    }
    if (s.queue) this.schedule(s);
  }
  input(id: string, data: string, binary = false) {
    const s = this.sessions.get(id);
    if (!s?.stream || s.status !== "connected")
      throw new Error("연결된 터미널이 아닙니다.");
    s.inputQueue!.input(data, binary);
  }
  paste(id: string, text: string, bracketed: boolean, generation: string) {
    const s = this.sessions.get(id);
    if (!s?.inputQueue || s.status !== "connected")
      throw new Error("연결된 터미널이 아닙니다.");
    return s.inputQueue.paste(text, bracketed, generation);
  }
  inputBusy(id: string) {
    return !!this.sessions.get(id)?.inputQueue?.busy;
  }
  resize(id: string, cols: number, rows: number, generation?: string) {
    const s = this.sessions.get(id);
    if (!s || (generation !== undefined && s.generation !== generation)) return;
    s.cols = cols;
    s.rows = rows;
    s.stream?.setWindow(rows, cols, 0, 0);
  }
  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.intentional = true;
    s.inputQueue?.dispose();
    clearTimeout(s.readyTimer);
    void s.cleanup?.();
    clearTimeout(s.retry);
    clearTimeout(s.flush);
    s.controller.abort();
    s.stream?.close();
    s.client?.end();
    s.queue = "";
    s.secret = {
      type: "password",
      password: "",
      privateKey: "",
      passphrase: "",
    };
    this.sessions.delete(id);
    this.status(s, "disconnected");
  }
  closeAll() {
    for (const id of this.sessions.keys()) this.close(id);
  }
}
