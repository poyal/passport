import type { Client } from "ssh2";
import { probeTunnels } from "./fixtures/tunnel-probe";
import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { connectSSH, Sessions } from "../src/main/ssh";
import { Store, type Vault } from "../src/main/store";
import { Files, LocalAdapter } from "../src/main/files";
import { Transfers } from "../src/main/transfers";
import { hostSchema, type Secret } from "../src/shared/model";
const manifest = process.env.PASSPORT_DOCKER_MANIFEST;
it.skipIf(!manifest)(
  "real OpenSSH across Docker operating systems",
  async () => {
    const config = JSON.parse(await fs.readFile(manifest!, "utf8")) as {
      hosts: { name: string; image: string; port: number; container: string }[];
      password: string;
      privateKey: string;
      passphrase: string;
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "passport-real-ssh-"));
    const vault: Vault = {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("unused");
      },
      decryptString: () => {
        throw new Error("unused");
      },
    };
    const store = new Store(root, vault),
      results: unknown[] = [];
    const password: Secret = {
      type: "password",
      password: config.password,
      privateKey: "",
      passphrase: "",
    };
    const key: Secret = {
      type: "key",
      password: "",
      privateKey: config.privateKey,
      passphrase: config.passphrase,
    };
    try {
      for (const entry of config.hosts) {
        const host = hostSchema.parse({
          id: randomUUID(),
          name: entry.name,
          address: "127.0.0.1",
          port: entry.port,
          username: "passport",
          environment: { PASSPORT_PROBE: "environment-ok" },
        });
        store.save({ ...store.read(), hosts: [...store.read().hosts, host] });
        let client: Client | undefined;
        for (let n = 0; n < 30; n++) {
          try {
            client = await connectSSH(host, password, store, async () => true);
            break;
          } catch (e) {
            if (n === 29) throw e;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const exec = (command: string) =>
          new Promise<string>((resolve, reject) =>
            client!.exec(command, (err, stream) => {
              if (err) return reject(err);
              let output = "";
              stream.on("data", (d: Buffer) => (output += d));
              stream.stderr.on("data", (d: Buffer) => (output += d));
              stream.on("close", (code: number) =>
                code ? reject(new Error(output)) : resolve(output),
              );
            }),
          );
        const osRelease = await exec("cat /etc/os-release");
        expect(osRelease).toContain("ID=");
        for (const shell of ["sh", "bash", "zsh"])
          expect(
            await exec(`${shell} -c 'printf "한글 SSH 정상\\n"'`),
          ).toContain("한글 SSH 정상");
        client!.end();
        client = await connectSSH(host, key, store, async () => {
          throw new Error("known fingerprint must not prompt");
        });
        try {
          await probeTunnels(store, host, key, client);
        } finally {
          client.end();
        }
        await expect(
          connectSSH(
            host,
            { ...password, password: "invalid-test-password" },
            store,
            async () => true,
          ),
        ).rejects.toThrow();
        const changed = hostSchema.parse({ ...host, address: "localhost" });
        store.trust(changed.address, changed.port, "SHA256:wrong");
        await expect(
          connectSSH(changed, password, store, async () => true),
        ).rejects.toThrow("키가 변경");
        const outputs: string[] = [];
        const id = randomUUID();
        let sessions: Sessions;
        sessions = new Sessions(
          store,
          async () => true,
          (event) => {
            if (event.kind === "output") {
              outputs.push(event.data);
              sessions.ack(id, event.bytes);
            }
          },
        );
        await sessions.open(id, host, password, 'printf "STARTED_ONCE\\n"');
        sessions.resize(id, 91, 37);
        sessions.input(
          id,
          'stty size; printf "%s\\n" "$PASSPORT_PROBE"; printf "터미널 입력 정상\\n"\r',
        );
        for (
          let n = 0;
          n < 80 &&
          !["37 91", "environment-ok", "터미널 입력 정상"].every((marker) =>
            outputs.join("").includes(marker),
          );
          n++
        )
          await new Promise((r) => setTimeout(r, 50));
        const output = outputs.join("");
        expect(output).toContain("37 91");
        expect(output).toContain("environment-ok");
        expect(output).toContain("터미널 입력 정상");
        sessions.closeAll();
        const files = new Files(store, async () => true),
          local = new LocalAdapter();
        files.adapters.set(local.endpoint.id, local);
        try {
          const a = await files.open(host, password),
            b = await files.open(host, key);
          const remote = files.get(a.id);
          const home = await remote.realpath(".");
          const folder = remote.join(home, "passport-" + randomUUID());
          await remote.mkdir(folder);
          const bytes = randomBytes(1024 * 1024);
          const source = path.join(root, entry.name + " 한글 파일.bin");
          await fs.writeFile(source, bytes);
          const transfers = new Transfers(files, () => {});
          const wait = async (job: string) => {
            for (let n = 0; n < 600; n++) {
              const j = transfers.jobs.get(job)!;
              if (!["queued", "running"].includes(j.state)) {
                expect(j.error).toBeUndefined();
                expect(j.state).toBe("completed");
                return;
              }
              await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error("transfer timeout");
          };
          await wait(
            transfers.add({
              source: local.endpoint.id,
              destination: a.id,
              paths: [source],
              target: folder,
              conflict: "skip",
            }).id,
          );
          const remoteFile = remote.join(folder, path.basename(source));
          await remote.chmod(remoteFile, 0o640);
          expect((await remote.stat(remoteFile))!.mode! & 0o777).toBe(0o640);
          const copyFolder = remote.join(folder, "copy");
          await remote.mkdir(copyFolder);
          await wait(
            transfers.add({
              source: a.id,
              destination: b.id,
              paths: [remoteFile],
              target: copyFolder,
              conflict: "skip",
            }).id,
          );
          const destination = path.join(root, entry.name);
          await fs.mkdir(destination);
          await wait(
            transfers.add({
              source: b.id,
              destination: local.endpoint.id,
              paths: [remote.join(copyFolder, path.basename(source))],
              target: destination,
              conflict: "skip",
            }).id,
          );
          expect(
            createHash("sha256")
              .update(
                await fs.readFile(
                  path.join(destination, path.basename(source)),
                ),
              )
              .digest("hex"),
          ).toBe(createHash("sha256").update(bytes).digest("hex"));
          await remote.remove(folder);
          results.push({
            os: entry.name,
            image: entry.image,
            status: "passed",
            password: true,
            encryptedEd25519: true,
            wrongPasswordRejected: true,
            changedHostKeyRejected: true,
            shells: ["sh", "bash", "zsh"],
            ptyResize: "37x91",
            environment: true,
            utf8: true,
            sftpBytes: bytes.length,
            sftpRemoteToRemote: true,
            forwarding: [
              "local",
              "remote",
              "SOCKS5 IPv4/domain fragmented handshake",
            ],
            socksUDPRejected: true,
            chmod: "0640",
            osRelease,
          });
        } finally {
          files.closeAll();
        }
      }
    } finally {
      await fs.mkdir("docs/benchmarks", { recursive: true });
      await fs.writeFile(
        "docs/benchmarks/docker-ssh.json",
        JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
      );
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
    expect(results).toHaveLength(config.hosts.length);
  },
  300000,
);
