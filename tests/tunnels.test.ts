import { afterEach, expect, it, vi } from "vitest";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { connectSSH } from "../src/main/ssh";
import { Tunnels } from "../src/main/tunnels";
import { hostSchema, tunnelSchema, type Secret } from "../src/shared/model";
import type { Store } from "../src/main/store";

vi.mock("../src/main/ssh", () => ({ connectSSH: vi.fn() }));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.resetAllMocks();
});
const host = hostSchema.parse({
  id: randomUUID(),
  name: "fixture",
  address: "127.0.0.1",
  username: "tester",
});
const secret: Secret = {
  type: "password",
  password: "fixture",
  privateKey: "",
  passphrase: "",
};
async function setup(kind: "local" | "dynamic" | "remote" = "local") {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const channels: PassThrough[] = [];
  const client = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
    forwardIn: vi.fn((_address, _port, callback) => callback()),
    unforwardIn: vi.fn((_address, _port, callback) => callback?.()),
    forwardOut: vi.fn((_from, _port, _to, _target, callback) => {
      const channel = new PassThrough();
      channels.push(channel);
      callback(null, channel);
    }),
  });
  vi.mocked(connectSSH).mockResolvedValue(client as never);
  const manager = new Tunnels(
    {} as Store,
    async () => true,
    () => {},
  );
  cleanups.push(() => manager.closeAll());
  const rule = tunnelSchema.parse({
    id: randomUUID(),
    hostId: host.id,
    name: kind,
    kind,
    bindPort: port,
    targetPort: 22,
  });
  return { manager, rule, client, channels };
}
async function dial(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  cleanups.push(() => {
    socket.destroy();
  });
  let bytes = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (data) => {
    bytes = Buffer.concat([bytes, Buffer.from(data)]);
  });
  await once(socket, "connect");
  return { socket, bytes: () => bytes };
}
it("stopping while remote forwarding is pending cannot resurrect the running badge", async () => {
  const { manager, rule, client } = await setup("remote");
  let complete!: () => void;
  client.forwardIn.mockImplementation((_address, _port, callback) => {
    complete = callback;
  });
  const starting = manager.start(rule, host, secret);
  await expect.poll(() => client.forwardIn.mock.calls.length).toBe(1);
  manager.stop(rule.id);
  complete();
  expect((await starting).status).toBe("stopped");
  expect(manager.states.get(rule.id)?.status).toBe("stopped");
  expect(manager.running.size).toBe(0);
});
it("a late SOCKS channel never receives a cancelled coalesced payload", async () => {
  const { manager, rule, client } = await setup("dynamic");
  let complete!: (error: null, channel: PassThrough) => void;
  client.forwardOut.mockImplementation((_a, _b, _c, _d, callback) => {
    complete = callback;
  });
  await manager.start(rule, host, secret);
  const peer = await dial(rule.bindPort);
  peer.socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 22]),
      Buffer.from("MUST_NOT_SEND"),
    ]),
  );
  await expect.poll(() => client.forwardOut.mock.calls.length).toBe(1);
  manager.stop(rule.id);
  const channel = new PassThrough();
  const write = vi.spyOn(channel, "write");
  complete(null, channel);
  expect(write).not.toHaveBeenCalled();
  expect(channel.destroyed).toBe(true);
});
it("local tunnels exchange exact bytes, reject duplicate starts and release every socket on stop", async () => {
  const { manager, rule, client, channels } = await setup();
  expect((await manager.start(rule, host, secret)).status).toBe("running");
  await expect(manager.start(rule, host, secret)).rejects.toThrow("이미 실행");
  const peer = await dial(rule.bindPort);
  const payload = Buffer.from("한글\0binary\r\n💻");
  peer.socket.write(payload);
  await expect
    .poll(() => peer.bytes().toString("hex"))
    .toBe(payload.toString("hex"));
  manager.stop(rule.id);
  await expect.poll(() => peer.socket.destroyed).toBe(true);
  expect(channels.every((c) => c.destroyed)).toBe(true);
  expect(client.end).toHaveBeenCalledTimes(1);
  expect(manager.running.size).toBe(0);
});
it("a busy local port reports failure without closing the existing listener and can be retried", async () => {
  const { manager, rule } = await setup();
  const owner = net.createServer();
  owner.listen(rule.bindPort, "127.0.0.1");
  await once(owner, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => owner.close(() => resolve())),
  );
  expect((await manager.start(rule, host, secret)).status).toBe("error");
  expect(owner.listening).toBe(true);
  expect(manager.running.size).toBe(0);
  await new Promise<void>((resolve) => owner.close(() => resolve()));
  expect((await manager.start(rule, host, secret)).status).toBe("running");
});
it("SOCKS accepts fragmented greetings and preserves bytes coalesced with the connect request", async () => {
  const { manager, rule, client } = await setup("dynamic");
  await manager.start(rule, host, secret);
  const peer = await dial(rule.bindPort);
  peer.socket.write(Buffer.from([5]));
  peer.socket.write(Buffer.from([1, 0]));
  await expect.poll(() => [...peer.bytes()]).toEqual([5, 0]);
  const body = Buffer.from("SOCKS 한글");
  peer.socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 0, 3, 9]),
      Buffer.from("localhost"),
      Buffer.from([0, 22]),
      body,
    ]),
  );
  await expect
    .poll(() => peer.bytes().subarray(12).toString())
    .toBe(body.toString());
  expect(client.forwardOut.mock.calls[0].slice(2, 4)).toEqual([
    "localhost",
    22,
  ]);
});
it("SOCKS rejects unsupported authentication and oversized handshakes without opening SSH channels", async () => {
  const { manager, rule, client } = await setup("dynamic");
  await manager.start(rule, host, secret);
  const peer = await dial(rule.bindPort);
  peer.socket.write(Buffer.from([5, 1, 2]));
  await expect.poll(() => [...peer.bytes()]).toEqual([5, 255]);
  const huge = await dial(rule.bindPort);
  huge.socket.write(Buffer.alloc(8193, 5));
  await expect.poll(() => huge.socket.destroyed).toBe(true);
  expect(client.forwardOut).not.toHaveBeenCalled();
});
it("stopping during authentication prevents a late successful connection from starting a listener", async () => {
  const { manager, rule, client } = await setup();
  let ready!: (client: any) => void;
  vi.mocked(connectSSH).mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const pending = manager.start(rule, host, secret);
  manager.stop(rule.id);
  ready(client);
  expect((await pending).status).toBe("stopped");
  expect(manager.running.size).toBe(0);
  expect(client.end).toHaveBeenCalled();
});
it("an SSH disconnect closes a running tunnel and reports a retryable error", async () => {
  const { manager, rule, client } = await setup();
  await manager.start(rule, host, secret);
  const peer = await dial(rule.bindPort);
  client.emit("close");
  await expect.poll(() => peer.socket.destroyed).toBe(true);
  expect(manager.states.get(rule.id)?.status).toBe("error");
  expect(manager.running.size).toBe(0);
});
it("a stopped listener's late error cannot stop a replacement tunnel with the same rule", async () => {
  const { manager, rule } = await setup();
  await manager.start(rule, host, secret);
  const old = manager.running.get(rule.id)!.server!;
  const closed = once(old, "close");
  manager.stop(rule.id);
  await closed;
  await manager.start(rule, host, secret);
  const replacement = manager.running.get(rule.id);
  old.emit("error", new Error("Old listener failed after stop"));
  expect(manager.running.get(rule.id)).toBe(replacement);
  expect(manager.states.get(rule.id)?.status).toBe("running");
  const peer = await dial(rule.bindPort);
  peer.socket.write("replacement is live");
  await expect.poll(() => peer.bytes().toString()).toBe("replacement is live");
});
