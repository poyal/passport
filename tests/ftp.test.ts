import { it, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { Client } from "basic-ftp";
import { Files, LocalAdapter, FTPAdapter } from "../src/main/files";
import { Transfers } from "../src/main/transfers";
import { hostSchema, type Secret } from "../src/shared/model";
import type { Store } from "../src/main/store";
const python = process.env.FTP_TEST_PYTHON;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(tls = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "passport-ftp-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const cert = path.join(root, "cert.pem"),
    key = path.join(root, "key.pem");
  if (tls)
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
  const child = spawn(
    python!,
    ["tests/fixtures/ftp-server.py", root, ...(tls ? [cert, key] : [])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("FTP fixture did not start")),
      10000,
    );
    child.once("error", reject);
    child.stdout!.once("data", (data) => {
      clearTimeout(timer);
      resolve(Number(data.toString().trim()));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`FTP fixture exited ${code}`));
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  );
  return { root, port, cert };
}
const secret: Secret = {
  type: "password",
  password: "test-only-password",
  privateKey: "",
  passphrase: "",
};
async function wait(transfers: Transfers, id: string) {
  for (let n = 0; n < 2000; n++) {
    const j = transfers.jobs.get(id)!;
    if (!["running", "queued"].includes(j.state)) {
      expect(j.error).toBeUndefined();
      expect(j.state).toBe("completed");
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("transfer timeout");
}
it.skipIf(!python)(
  "FTP passive upload and remote-to-remote copy use separate serialized connections",
  async () => {
    const { root, port } = await fixture();
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "FTP test",
      address: "127.0.0.1",
      port,
      username: "tester",
      protocol: "ftp",
    });
    const files = new Files(
      { read: () => ({ hosts: [host] }) } as unknown as Store,
      async () => false,
    );
    cleanups.push(async () => files.closeAll());
    await fs.mkdir(path.join(root, "a"));
    await fs.mkdir(path.join(root, "b"));
    const data = randomBytes(2 * 1024 * 1024);
    await fs.writeFile(path.join(root, "input.bin"), data);
    const a = new LocalAdapter();
    files.adapters.set(a.endpoint.id, a);
    const b = await files.open(host, secret),
      c = await files.open(host, secret);
    const transfers = new Transfers(files, () => {});
    await wait(
      transfers,
      transfers.add({
        source: a.endpoint.id,
        destination: b.id,
        paths: [path.join(root, "input.bin")],
        target: "/a",
        conflict: "skip",
      }).id,
    );
    await wait(
      transfers,
      transfers.add({
        source: b.id,
        destination: c.id,
        paths: ["/a/input.bin"],
        target: "/b",
        conflict: "skip",
      }).id,
    );
    expect(await fs.readFile(path.join(root, "b", "input.bin"))).toEqual(data);
  },
);
it.skipIf(!python)(
  "FTPS rejects untrusted certificates and transfers through explicit TLS with a trusted test CA",
  async () => {
    const { root, port, cert } = await fixture(true);
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "TLS test",
      address: "127.0.0.1",
      port,
      username: "tester",
      protocol: "ftps",
    });
    const files = new Files(
      { read: () => ({ hosts: [host] }) } as unknown as Store,
      async () => false,
    );
    cleanups.push(async () => files.closeAll());
    await expect(files.open(host, secret)).rejects.toThrow();
    const ftp = new Client(15000);
    await ftp.access({
      host: "127.0.0.1",
      port,
      user: "tester",
      password: secret.password,
      secure: true,
      secureOptions: { ca: await fs.readFile(cert), rejectUnauthorized: true },
    });
    const ep = {
      id: randomUUID(),
      hostId: host.id,
      protocol: "ftps" as const,
      label: host.name,
      initialPath: "/",
    };
    const remote = new FTPAdapter(ep, ftp),
      local = new LocalAdapter();
    files.adapters.set(ep.id, remote);
    files.adapters.set(local.endpoint.id, local);
    await fs.mkdir(path.join(root, "secure"));
    await fs.writeFile(path.join(root, "input.txt"), "encrypted transport");
    const transfers = new Transfers(files, () => {});
    await wait(
      transfers,
      transfers.add({
        source: local.endpoint.id,
        destination: ep.id,
        paths: [path.join(root, "input.txt")],
        target: "/secure",
        conflict: "skip",
      }).id,
    );
    expect(
      await fs.readFile(path.join(root, "secure", "input.txt"), "utf8"),
    ).toBe("encrypted transport");
  },
  30000,
);
