import ssh2, { type ServerChannel } from "ssh2";
const { Server, utils } = ssh2;
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
export async function sshFixture(root: string) {
  root = await fs.realpath(root);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const encryptedKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-key-passphrase",
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const authKey = utils.parseKey(encryptedKey, "test-key-passphrase");
  if (authKey instanceof Error || Array.isArray(authKey))
    throw new Error("key fixture");
  const clients = new Set<import("ssh2").Connection>(),
    input: string[] = [],
    shells: ServerChannel[] = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === "tester" &&
        ctx.password === "test-only-password"
      )
        ctx.accept();
      else if (
        ctx.method === "publickey" &&
        ctx.username === "tester" &&
        ctx.key.data.equals(authKey.getPublicSSH()) &&
        (!ctx.signature ||
          authKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept) => {
          const stream = accept();
          stream.end('Linux\nPRETTY_NAME="Alpine Linux 3.22"\n');
          stream.exit(0);
        });
        session.on("pty", (accept) => accept?.());
        session.on("window-change", (accept) => accept?.());
        session.on("shell", (accept) => {
          const stream = accept();
          shells.push(stream);
          stream.write(
            "\x1b[?2004h\x1b[32m테스트 서버에 연결되었습니다.\x1b[0m\r\n$ ",
          );
          stream.on("data", (chunk: Buffer) => {
            input.push(chunk.toString());
            stream.write(chunk);
          });
        });
        session.on("sftp", (accept) => {
          const sftp = accept();
          let count = 0;
          const handles = new Map<
            string,
            { file?: fs.FileHandle; directory?: string; listed?: boolean }
          >();
          const local = (p: string) => {
            const value = path.resolve(root, "." + path.posix.resolve("/", p));
            if (value !== root && !value.startsWith(root + path.sep))
              throw new Error("path");
            return value;
          };
          const attrs = (s: Stats) => ({
            mode: s.mode,
            uid: s.uid,
            gid: s.gid,
            size: s.size,
            atime: Math.floor(s.atimeMs / 1000),
            mtime: Math.floor(s.mtimeMs / 1000),
          });
          const error = (id: number, e: unknown) =>
            sftp.status(
              id,
              (e as NodeJS.ErrnoException).code === "ENOENT" ? 2 : 4,
            );
          const run = (id: number, fn: () => Promise<void>) =>
            void fn().catch((e) => error(id, e));
          sftp.on("REALPATH", (id, p) =>
            run(id, async () => {
              const canonical = await fs.realpath(local(p));
              const remote =
                "/" + path.relative(root, canonical).split(path.sep).join("/");
              sftp.name(id, [
                {
                  filename: remote,
                  longname: remote,
                  attrs: {
                    mode: 0o40755,
                    uid: 0,
                    gid: 0,
                    size: 0,
                    atime: 0,
                    mtime: 0,
                  },
                },
              ]);
            }),
          );
          sftp.on("STAT", (id, p) =>
            run(id, async () => sftp.attrs(id, attrs(await fs.stat(local(p))))),
          );
          sftp.on("LSTAT", (id, p) =>
            run(id, async () =>
              sftp.attrs(id, attrs(await fs.lstat(local(p)))),
            ),
          );
          sftp.on("OPENDIR", (id, p) =>
            run(id, async () => {
              const dir = local(p);
              if (!(await fs.stat(dir)).isDirectory())
                throw new Error("not directory");
              const h = String(++count);
              handles.set(h, { directory: dir });
              sftp.handle(id, Buffer.from(h));
            }),
          );
          sftp.on("READDIR", (id, h) =>
            run(id, async () => {
              const entry = handles.get(h.toString());
              if (!entry?.directory || entry.listed) {
                sftp.status(id, 1);
                return;
              }
              entry.listed = true;
              const names = await fs.readdir(entry.directory);
              sftp.name(
                id,
                await Promise.all(
                  names.map(async (name) => ({
                    filename: name,
                    longname: name,
                    attrs: attrs(
                      await fs.lstat(path.join(entry.directory!, name)),
                    ),
                  })),
                ),
              );
            }),
          );
          sftp.on("OPEN", (id, p, flags, at) =>
            run(id, async () => {
              const f = await fs.open(
                local(p),
                utils.sftp.flagsToString(flags) ?? "r",
                at.mode ?? 0o644,
              );
              const h = String(++count);
              handles.set(h, { file: f });
              sftp.handle(id, Buffer.from(h));
            }),
          );
          sftp.on("READ", (id, h, offset, length) =>
            run(id, async () => {
              const f = handles.get(h.toString())?.file;
              if (!f) throw new Error("handle");
              const buffer = Buffer.alloc(Math.min(length, 65536));
              const { bytesRead } = await f.read(
                buffer,
                0,
                buffer.length,
                offset,
              );
              if (!bytesRead) sftp.status(id, 1);
              else sftp.data(id, buffer.subarray(0, bytesRead));
            }),
          );
          sftp.on("WRITE", (id, h, offset, data) =>
            run(id, async () => {
              const f = handles.get(h.toString())?.file;
              if (!f) throw new Error("handle");
              await f.write(data, 0, data.length, offset);
              sftp.status(id, 0);
            }),
          );
          sftp.on("FSTAT", (id, h) =>
            run(id, async () => {
              const f = handles.get(h.toString())?.file;
              if (!f) throw new Error("handle");
              sftp.attrs(id, attrs(await f.stat()));
            }),
          );
          sftp.on("CLOSE", (id, h) =>
            run(id, async () => {
              const entry = handles.get(h.toString());
              await entry?.file?.close();
              handles.delete(h.toString());
              sftp.status(id, 0);
            }),
          );
          sftp.on("MKDIR", (id, p) =>
            run(id, async () => {
              await fs.mkdir(local(p));
              sftp.status(id, 0);
            }),
          );
          sftp.on("RMDIR", (id, p) =>
            run(id, async () => {
              await fs.rmdir(local(p));
              sftp.status(id, 0);
            }),
          );
          sftp.on("REMOVE", (id, p) =>
            run(id, async () => {
              await fs.unlink(local(p));
              sftp.status(id, 0);
            }),
          );
          sftp.on("RENAME", (id, a, b) =>
            run(id, async () => {
              await fs.rename(local(a), local(b));
              sftp.status(id, 0);
            }),
          );
          sftp.on("SETSTAT", (id, p, at) =>
            run(id, async () => {
              if (at.mode !== undefined) await fs.chmod(local(p), at.mode);
              sftp.status(id, 0);
            }),
          );
          sftp.on("end", () => {
            for (const h of handles.values())
              void h.file?.close().catch(() => {});
            handles.clear();
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    input,
    shells,
    privateKey,
    encryptedKey,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
