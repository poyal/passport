import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Sessions } from "../src/main/ssh";
import { hostSchema, type AppEvent } from "../src/shared/model";
import type { Store } from "../src/main/store";

const clients = vi.hoisted(() => [] as any[]);
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      channel = Object.assign(new EventEmitter(), {
        stderr: Object.assign(new EventEmitter(), { pause() {}, resume() {} }),
        pause() {},
        resume() {},
        close() {},
        setWindow() {},
        write() {},
      });
      connect() {
        clients.push(this);
      }
      shell(_pty: unknown, _options: unknown, done: Function) {
        done(undefined, this.channel);
      }
      end() {}
      destroy() {}
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  clients.length = 0;
});

it("drains a closing SSH stream in bounded Unicode-safe events that can each be acknowledged", async () => {
  const events: AppEvent[] = [];
  const manager = new Sessions(
    {} as Store,
    async () => true,
    (event) => events.push(event),
  );
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "closing fixture",
    address: "127.0.0.1",
    username: "test",
  });
  try {
    const opening = manager.open("pane", host, {
      type: "password",
      password: "fixture",
      privateKey: "",
      passphrase: "",
    });
    clients[0].emit("ready");
    await opening;
    const text = "a".repeat(32767) + "💻" + "한".repeat(100000);
    clients[0].channel.emit("data", Buffer.from(text));
    clients[0].channel.emit("close");
    const output = events.filter((event) => event.kind === "output");
    expect(
      Buffer.concat(output.map((event) => Buffer.from(event.data))),
    ).toEqual(Buffer.from(text));
    for (const event of output) {
      expect(event.bytes).toBeLessThanOrEqual(262144);
      manager.ack(event.id, event.bytes, event.generation);
    }
    expect(manager.sessions.get("pane")!.inFlight).toBe(0);
  } finally {
    manager.closeAll();
  }
});

it("ignores old SSH data, close and error callbacks while the replacement is still connecting", async () => {
  vi.useFakeTimers();
  const events: AppEvent[] = [];
  const manager = new Sessions(
    {} as Store,
    async () => true,
    (e) => events.push(e),
  );
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "fixture",
    address: "127.0.0.1",
    username: "test",
    autoReconnect: true,
  });
  try {
    const opened = manager.open("pane", host, {
      type: "password",
      password: "fixture",
      privateKey: "",
      passphrase: "",
    });
    const old = clients[0];
    old.emit("ready");
    await opened;
    const previous = manager.sessions.get("pane")!.generation;
    old.emit("close");
    await vi.advanceTimersByTimeAsync(1000);
    const current = manager.sessions.get("pane")!.generation;
    expect(current).not.toBe(previous);
    old.channel.emit("data", Buffer.from("STALE_STDOUT"));
    old.channel.stderr.emit("data", Buffer.from("STALE_STDERR"));
    old.emit("error", new Error("Old connection failed late"));
    old.channel.emit("close");
    await vi.advanceTimersByTimeAsync(10);
    expect(events.filter((e) => e.kind === "output")).toEqual([]);
    expect(manager.sessions.get("pane")!.status).toBe("connecting");
    clients[1].emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    clients[1].channel.emit("data", Buffer.from("새 연결💻"));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.filter((e) => e.kind === "output")).toEqual([
      {
        kind: "output",
        id: "pane",
        generation: current,
        data: "새 연결💻",
        bytes: Buffer.byteLength("새 연결💻"),
      },
    ]);
  } finally {
    manager.closeAll();
  }
});
