import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { sshFixture } from "./fixtures/ssh-server";
import { hostSchema, type Secret } from "../src/shared/model";
import { connectSSH, Sessions } from "../src/main/ssh";
import { Files, LocalAdapter } from "../src/main/files";
import { Transfers } from "../src/main/transfers";
import type { Store } from "../src/main/store";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
it("authenticates with a passphrase-protected PEM key and rejects a wrong passphrase", async () => {
  const { host, store, server } = await setup();
  const secret: Secret = {
    type: "key",
    password: "",
    privateKey: server.encryptedKey,
    passphrase: "test-key-passphrase",
  };
  const client = await connectSSH(host, secret, store, async () => true);
  client.end();
  await expect(
    connectSSH(
      host,
      { ...secret, passphrase: "incorrect" },
      store,
      async () => true,
    ),
  ).rejects.toThrow();
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "passport-ssh-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const server = await sshFixture(root);
  cleanups.push(() => server.close());
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "test",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
  });
  const known = new Map<string, string>();
  const store = {
    fingerprint: (address: string, port: number) =>
      known.get(`${address}:${port}`),
    trust: (address: string, port: number, fingerprint: string) =>
      known.set(`${address}:${port}`, fingerprint),
    read: () => ({ hosts: [host] }),
  } as unknown as Store;
  const secret: Secret = {
    type: "password",
    password: "test-only-password",
    privateKey: "",
    passphrase: "",
  };
  return { root, server, host, store, secret, known };
}
it("confirms a first fingerprint and blocks changed keys", async () => {
  const { host, store, secret, known } = await setup();
  let confirmations = 0;
  const client = await connectSSH(host, secret, store, async () => {
    confirmations++;
    return true;
  });
  client.end();
  expect(confirmations).toBe(1);
  expect(known.size).toBe(1);
  known.set(`${host.address}:${host.port}`, "SHA256:wrong");
  await expect(
    connectSSH(host, secret, store, async () => true),
  ).rejects.toThrow("키가 변경");
});
it("opens an interactive SSH terminal and routes output and input", async () => {
  const { host, store, secret, server } = await setup();
  const output: string[] = [];
  const manager = new Sessions(
    store,
    async () => true,
    (e) => {
      if (e.kind === "output") {
        output.push(e.data);
        manager.ack(e.id, e.bytes);
      }
    },
  );
  cleanups.push(async () => manager.closeAll());
  const id = randomUUID();
  await manager.open(id, host, secret);
  manager.input(id, "hello");
  for (let n = 0; n < 100 && !output.join("").includes("hello"); n++)
    await new Promise((r) => setTimeout(r, 20));
  expect(output.join("")).toContain("테스트 서버");
  expect(server.input.join("")).toBe("hello");
  manager.resize(id, 120, 40);
  manager.close(id);
  expect(manager.sessions.size).toBe(0);
});
it("runs a startup command once and never repeats it after automatic reconnect", async () => {
  const { host, store, secret, server } = await setup();
  const manager = new Sessions(
    store,
    async () => true,
    (e) => {
      if (e.kind === "output") manager.ack(e.id, e.bytes);
    },
  );
  cleanups.push(async () => manager.closeAll());
  const id = randomUUID();
  await manager.open(
    id,
    { ...host, autoReconnect: true },
    secret,
    "STARTUP_ONCE",
  );
  for (let n = 0; n < 100 && !server.input.length; n++)
    await new Promise((r) => setTimeout(r, 20));
  expect(server.input.join("")).toBe("STARTUP_ONCE\r");
  server.shells[0].close();
  for (let n = 0; n < 200 && server.shells.length < 2; n++)
    await new Promise((r) => setTimeout(r, 20));
  expect(server.shells.length).toBe(2);
  manager.input(id, "AFTER_RECONNECT");
  for (
    let n = 0;
    n < 100 && !server.input.join("").includes("AFTER_RECONNECT");
    n++
  )
    await new Promise((r) => setTimeout(r, 20));
  expect(server.input.join("")).toBe("STARTUP_ONCE\rAFTER_RECONNECT");
});
it("streams local → SFTP → a different SFTP connection and changes permissions", async () => {
  const { host, store, secret, root } = await setup();
  await fs.mkdir(path.join(root, "source"));
  await fs.mkdir(path.join(root, "target"));
  await fs.mkdir(path.join(root, "second"));
  const data = randomBytes(1024 * 1024);
  await fs.writeFile(path.join(root, "source", "한글 file.bin"), data);
  const files = new Files(store, async () => true);
  cleanups.push(async () => files.closeAll());
  const a = new LocalAdapter();
  files.adapters.set(a.endpoint.id, a);
  const b = await files.open(host, secret),
    c = await files.open(host, secret);
  const transfers = new Transfers(files, () => {});
  const wait = async (id: string) => {
    for (let n = 0; n < 1000; n++) {
      const j = transfers.jobs.get(id)!;
      if (!["running", "queued"].includes(j.state)) {
        expect(j.error).toBeUndefined();
        expect(j.state).toBe("completed");
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  const first = transfers.add({
    source: a.endpoint.id,
    destination: b.id,
    paths: [path.join(root, "source", "한글 file.bin")],
    target: "/target",
    conflict: "skip",
  });
  await wait(first.id);
  const second = transfers.add({
    source: b.id,
    destination: c.id,
    paths: ["/target/한글 file.bin"],
    target: "/second",
    conflict: "skip",
  });
  await wait(second.id);
  expect(await fs.readFile(path.join(root, "second", "한글 file.bin"))).toEqual(
    data,
  );
  await fs.chmod(path.join(root, "second", "한글 file.bin"), 0o2644);
  await files.action(
    c.id,
    "chmod",
    ["/second/한글 file.bin"],
    undefined,
    0o600,
  );
  if (process.platform !== "win32")
    expect(
      (await fs.stat(path.join(root, "second", "한글 file.bin"))).mode & 0o7777,
    ).toBe(0o2600);
}, 30000);
