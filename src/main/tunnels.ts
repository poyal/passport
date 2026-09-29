import net, { type Socket, type Server } from "node:net";
import { type Client, type ClientChannel } from "ssh2";
import { connectSSH, type TrustPrompt } from "./ssh";
import type { Store } from "./store";
import type { Host, Secret, TunnelRule, TunnelState } from "../shared/model";
type Running = {
  rule: TunnelRule;
  controller: AbortController;
  client?: Client;
  server?: Server;
  sockets: Set<Socket | ClientChannel>;
  stopping: boolean;
};
export class Tunnels {
  running = new Map<string, Running>();
  states = new Map<string, TunnelState>();
  constructor(
    readonly store: Store,
    readonly confirm: TrustPrompt,
    readonly emit: (state: TunnelState) => void,
  ) {}
  private status(id: string, status: TunnelState["status"], message?: string) {
    const state = { id, status, message };
    this.states.set(id, state);
    this.emit(state);
    return state;
  }
  async start(rule: TunnelRule, host: Host, secret: Secret) {
    if (this.running.has(rule.id))
      throw new Error("이미 실행 중인 터널입니다.");
    const r: Running = {
      rule,
      controller: new AbortController(),
      sockets: new Set(),
      stopping: false,
    };
    this.running.set(rule.id, r);
    this.status(rule.id, "starting");
    try {
      r.client = await connectSSH(
        host,
        secret,
        this.store,
        this.confirm,
        r.controller.signal,
      );
      if (r.stopping) throw new Error("터널을 중지했습니다.");
      r.client.once("close", () => {
        if (!r.stopping) {
          this.stop(rule.id);
          this.status(rule.id, "error", "SSH 연결이 종료되었습니다.");
        }
      });
      r.client.on("error", (e) => {
        if (!r.stopping) {
          this.stop(rule.id);
          this.status(rule.id, "error", e.message);
        }
      });
      if (rule.kind === "remote") {
        r.client.on("tcp connection", (info, accept, reject) => {
          if (info.destPort !== rule.bindPort || r.stopping) {
            reject();
            return;
          }
          const socket = net.connect(rule.targetPort, rule.targetAddress);
          this.track(r, socket);
          let accepted = false;
          socket.once("connect", () => {
            accepted = true;
            this.bridge(r, socket, accept());
          });
          socket.once("error", () => {
            if (!accepted) {
              accepted = true;
              reject();
            }
          });
          socket.setTimeout(15000, () => socket.destroy());
        });
        await new Promise<void>((resolve, reject) =>
          r.client!.forwardIn(rule.bindAddress, rule.bindPort, (err) =>
            err ? reject(err) : resolve(),
          ),
        );
      } else {
        r.server = net.createServer((socket) => {
          this.track(r, socket);
          socket.on("error", () => {});
          socket.setTimeout(15000, () => socket.destroy());
          if (rule.kind === "dynamic") this.socks(r, socket);
          else this.forward(r, socket, rule.targetAddress, rule.targetPort);
        });
        await new Promise<void>((resolve, reject) => {
          r.server!.once("error", reject);
          r.server!.listen(rule.bindPort, rule.bindAddress, () => {
            r.server!.off("error", reject);
            resolve();
          });
        });
        r.server.on("error", (e) => {
          this.stop(rule.id);
          this.status(rule.id, "error", e.message);
        });
      }
      return this.status(rule.id, "running");
    } catch (e) {
      if (r.stopping)
        return (
          this.states.get(rule.id) || {
            id: rule.id,
            status: "stopped" as const,
          }
        );
      this.stop(rule.id);
      return this.status(
        rule.id,
        "error",
        e instanceof Error ? e.message : "터널 시작 실패",
      );
    }
  }
  private track(r: Running, s: Socket | ClientChannel) {
    r.sockets.add(s);
    s.once("close", () => r.sockets.delete(s));
    s.on("error", () => s.destroy());
  }
  private bridge(r: Running, socket: Socket, channel: ClientChannel) {
    if (r.stopping || socket.destroyed) {
      socket.destroy();
      channel.destroy();
      return;
    }
    this.track(r, channel);
    socket.setTimeout(0);
    socket.pipe(channel).pipe(socket);
    socket.once("close", () => channel.destroy());
    channel.once("close", () => socket.destroy());
    socket.resume();
  }
  private forward(
    r: Running,
    socket: Socket,
    address: string,
    port: number,
    prefix?: Buffer,
  ) {
    socket.pause();
    r.client!.forwardOut(
      socket.remoteAddress || "127.0.0.1",
      socket.remotePort || 0,
      address,
      port,
      (err, channel) => {
        if (err) {
          if (prefix) socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          else socket.destroy();
          return;
        }
        if (prefix) {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (prefix.length) channel.write(prefix);
        }
        this.bridge(r, socket, channel);
      },
    );
  }
  private socks(r: Running, socket: Socket) {
    let data = Buffer.alloc(0),
      greeted = false;
    const receive = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 8192) {
        socket.destroy();
        return;
      }
      if (!greeted) {
        if (data.length < 2) return;
        const count = data[1];
        if (data.length < 2 + count) return;
        if (data[0] !== 5 || !data.subarray(2, 2 + count).includes(0)) {
          socket.end(Buffer.from([5, 255]));
          return;
        }
        socket.write(Buffer.from([5, 0]));
        data = data.subarray(2 + count);
        greeted = true;
      }
      if (data.length < 4) return;
      if (data[0] !== 5 || data[1] !== 1 || data[2] !== 0) {
        socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      let length = 0,
        host = "";
      const type = data[3];
      if (type === 1) {
        length = 4;
        if (data.length < 10) return;
        host = [...data.subarray(4, 8)].join(".");
      } else if (type === 3) {
        if (data.length < 5) return;
        length = 1 + data[4];
        if (data.length < 6 + length) return;
        host = data.subarray(5, 4 + length).toString("utf8");
      } else if (type === 4) {
        length = 16;
        if (data.length < 22) return;
        host = Array.from({ length: 8 }, (_, i) =>
          data.readUInt16BE(4 + i * 2).toString(16),
        ).join(":");
      } else {
        socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const port = data.readUInt16BE(4 + length);
      if (!host || !port || /[\s\0]/.test(host)) {
        socket.destroy();
        return;
      }
      socket.off("data", receive);
      this.forward(r, socket, host, port, data.subarray(6 + length));
    };
    socket.on("data", receive);
  }
  stop(id: string) {
    const r = this.running.get(id);
    if (r) {
      r.stopping = true;
      r.server?.close();
      if (r.rule.kind === "remote") {
        try {
          r.client?.unforwardIn(r.rule.bindAddress, r.rule.bindPort, () => {});
        } catch {
          /* Connection may already be closed. */
        }
      }
      r.controller.abort();
      for (const s of r.sockets) s.destroy();
      r.client?.end();
      this.running.delete(id);
    }
    this.status(id, "stopped");
  }
  closeAll() {
    for (const id of this.running.keys()) this.stop(id);
  }
}
