import { Client, type ClientChannel } from "ssh2";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AppEvent, Host, Secret } from "../shared/model";
import type { Store } from "./store";

export type TrustPrompt = (host: Host, fingerprint: string) => Promise<boolean>;
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
      if (!ready)
        reject(new Error(rejection || `SSH 연결 실패: ${error.message}`));
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
  host: Host;
  secret: Secret;
  controller: AbortController;
  client?: Client;
  stream?: ClientChannel;
  decoder: StringDecoder;
  queue: string;
  inFlight: number;
  flush?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  intentional: boolean;
  status: string;
  cols: number;
  rows: number;
};
export class Sessions {
  readonly sessions = new Map<string, Session>();
  constructor(
    readonly store: Store,
    readonly confirm: TrustPrompt,
    readonly emit: (event: AppEvent) => void,
  ) {}
  async open(id: string, host: Host, secret: Secret, startup?: string) {
    if (host.protocol !== "ssh")
      throw new Error("SSH 호스트만 터미널에 연결할 수 있습니다.");
    if (this.sessions.has(id)) this.close(id);
    if (this.sessions.size >= 32)
      throw new Error("최대 32개 SSH 세션을 열 수 있습니다.");
    const s: Session = {
      id,
      host,
      secret,
      controller: new AbortController(),
      decoder: new StringDecoder("utf8"),
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
    this.emit({ kind: "session", state: { id: s.id, status, message } });
  }
  private async connect(s: Session, startup?: string) {
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
      s.client = client;
      if (s.intentional) {
        client.end();
        return;
      }
      const stream = await new Promise<ClientChannel>((resolve, reject) =>
        client.shell(
          { term: "xterm-256color", cols: s.cols, rows: s.rows },
          { env: s.host.environment },
          (err, channel) => (err ? reject(err) : resolve(channel)),
        ),
      );
      if (s.intentional) {
        stream.close();
        return;
      }
      s.stream = stream;
      this.status(s, "connected");
      stream.on("data", (data: Buffer) => {
        s.queue += s.decoder.write(data);
        if (s.inFlight + Buffer.byteLength(s.queue) >= 256 * 1024) {
          stream.pause();
          stream.stderr.pause();
        }
        this.schedule(s);
      });
      stream.stderr.on("data", (data: Buffer) => {
        s.queue += s.decoder.write(data);
        if (s.inFlight + Buffer.byteLength(s.queue) >= 256 * 1024) {
          stream.pause();
          stream.stderr.pause();
        }
        this.schedule(s);
      });
      stream.once("close", () => {
        s.queue += s.decoder.end();
        this.schedule(s);
        client.end();
      });
      if (startup) stream.write(startup + "\r");
      client.once("close", () => this.disconnected(s));
      client.on("error", (error) => {
        if (!s.intentional)
          this.status(s, "error", `SSH 연결 오류: ${error.message}`);
      });
    } catch (error) {
      if (s.intentional) return;
      const message =
        error instanceof Error ? error.message : "SSH 연결에 실패했습니다.";
      this.status(s, "error", message);
      if (!/auth|인증|키|password|private|passphrase/i.test(message))
        this.reconnect(s);
    }
  }
  private disconnected(s: Session) {
    if (s.intentional) return;
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
      void this.connect(s);
    }, delay);
  }
  private schedule(s: Session) {
    if (!s.flush)
      s.flush = setTimeout(() => {
        s.flush = undefined;
        if (s.intentional || !s.queue || s.inFlight >= 256 * 1024) return;
        const data = s.queue.slice(0, 32768);
        s.queue = s.queue.slice(data.length);
        const bytes = Buffer.byteLength(data);
        s.inFlight += bytes;
        this.emit({ kind: "output", id: s.id, data, bytes });
        if (s.queue) this.schedule(s);
      }, 8);
  }
  ack(id: string, bytes: number) {
    const s = this.sessions.get(id);
    if (!s) return;
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
    s.stream.write(Buffer.from(data, binary ? "latin1" : "utf8"));
  }
  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.cols = cols;
    s.rows = rows;
    s.stream?.setWindow(rows, cols, 0, 0);
  }
  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.intentional = true;
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
