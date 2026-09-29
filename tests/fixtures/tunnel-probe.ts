import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { Client } from "ssh2";
import { expect } from "vitest";
import { Tunnels } from "../../src/main/tunnels";
import type { Store } from "../../src/main/store";
import { tunnelSchema, type Host, type Secret } from "../../src/shared/model";

export async function probeTunnels(
  store: Store,
  host: Host,
  secret: Secret,
  client: Client,
) {
  const tunnels = new Tunnels(
    store,
    async () => true,
    () => {},
  );
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  const sockets: net.Socket[] = [];
  const freePort = async () => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    return port;
  };
  const dial = async (port: number) => {
    const socket = net.connect(port, "127.0.0.1");
    sockets.push(socket);
    socket.setTimeout(5000, () => socket.destroy(new Error("tunnel timeout")));
    let bytes = Buffer.alloc(0);
    let error: Error | undefined;
    socket.on("data", (data) => {
      bytes = Buffer.concat([
        bytes,
        typeof data === "string" ? Buffer.from(data) : data,
      ]);
    });
    socket.on("error", (e) => {
      error = e;
    });
    await once(socket, "connect");
    return {
      socket,
      read: async (check: (b: Buffer) => boolean) => {
        for (let n = 0; n < 200 && !check(bytes); n++) {
          if (error) throw error;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(check(bytes)).toBe(true);
        return bytes;
      },
    };
  };
  try {
    const local = tunnelSchema.parse({
      id: randomUUID(),
      hostId: host.id,
      name: "local",
      kind: "local",
      bindPort: await freePort(),
      targetPort: 22,
    });
    expect((await tunnels.start(local, host, secret)).status).toBe("running");
    const localSocket = await dial(local.bindPort);
    await localSocket.read((b) => b.toString().includes("SSH-2.0-OpenSSH"));
    localSocket.socket.destroy();
    tunnels.stop(local.id);
    const dynamic = tunnelSchema.parse({
      ...local,
      id: randomUUID(),
      name: "dynamic",
      kind: "dynamic",
      bindPort: await freePort(),
    });
    expect((await tunnels.start(dynamic, host, secret)).status).toBe("running");
    for (const address of [
      Buffer.from([1, 127, 0, 0, 1]),
      Buffer.concat([Buffer.from([3, 9]), Buffer.from("localhost")]),
    ]) {
      const socks = await dial(dynamic.bindPort);
      socks.socket.write(Buffer.from([5]));
      await new Promise((r) => setTimeout(r, 10));
      socks.socket.write(Buffer.from([1, 0]));
      await socks.read((b) => b.length >= 2);
      socks.socket.write(Buffer.from([5, 1, 0]));
      await new Promise((r) => setTimeout(r, 10));
      socks.socket.write(Buffer.concat([address, Buffer.from([0, 22])]));
      const response = await socks.read((b) =>
        b.toString().includes("SSH-2.0-OpenSSH"),
      );
      expect([...response.subarray(0, 4)]).toEqual([5, 0, 5, 0]);
      socks.socket.destroy();
    }
    const unsupported = await dial(dynamic.bindPort);
    unsupported.socket.write(
      Buffer.from([5, 1, 0, 5, 3, 0, 1, 127, 0, 0, 1, 0, 22]),
    );
    expect([
      ...(await unsupported.read((b) => b.length >= 4)).subarray(0, 4),
    ]).toEqual([5, 0, 5, 7]);
    unsupported.socket.destroy();
    tunnels.stop(dynamic.id);
    const remote = tunnelSchema.parse({
      ...local,
      id: randomUUID(),
      name: "remote",
      kind: "remote",
      bindPort: 34567,
      targetPort: (echo.address() as AddressInfo).port,
    });
    expect((await tunnels.start(remote, host, secret)).status).toBe("running");
    await new Promise<void>((resolve, reject) => {
      client.forwardOut(
        "127.0.0.1",
        0,
        "127.0.0.1",
        remote.bindPort,
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          const timer = setTimeout(() => {
            stream.destroy();
            reject(new Error("remote tunnel timeout"));
          }, 5000);
          stream.once("error", reject);
          stream.once("data", (data: Buffer) => {
            clearTimeout(timer);
            try {
              expect(data.toString()).toBe("remote tunnel 한글");
              resolve();
            } catch (e) {
              reject(e);
            } finally {
              stream.destroy();
            }
          });
          stream.write("remote tunnel 한글");
        },
      );
    });
    tunnels.stop(remote.id);
    expect(tunnels.running.size).toBe(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    tunnels.closeAll();
    await new Promise<void>((r) => echo.close(() => r()));
  }
}
