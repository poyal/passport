import { detectRemoteOS } from "./remote-os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import { Client as FTP, FileType } from "basic-ftp";
import type { Client, SFTPWrapper } from "ssh2";
import type { Host, Secret, FileEntry, Endpoint } from "../shared/model";
import { connectSSH, type TrustPrompt } from "./ssh";
import type { Store } from "./store";

export interface FileAdapter {
  endpoint: Endpoint;
  connected: boolean;
  normalize(p: string): string;
  join(p: string, name: string): string;
  parent(p: string): string;
  list(p: string, options?: { skipUnreadable?: boolean }): Promise<FileEntry[]>;
  stat(p: string): Promise<FileEntry | null>;
  realpath(p: string): Promise<string>;
  mkdir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  download(p: string, dest: Writable, signal: AbortSignal): Promise<void>;
  upload(p: string, source: Readable, signal: AbortSignal): Promise<void>;
  close(): void;
}
const kind = (s: fs.Stats) =>
  s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : "file";
export class LocalAdapter implements FileAdapter {
  connected = true;
  endpoint: Endpoint = {
    id: randomUUID(),
    hostId: null,
    protocol: "local",
    label: "내 컴퓨터",
    initialPath: os.homedir(),
  };
  normalize(p: string) {
    return path.resolve(p || os.homedir());
  }
  join(p: string, name: string) {
    return path.join(p, name);
  }
  parent(p: string) {
    return path.dirname(p);
  }
  async list(p: string, options?: { skipUnreadable?: boolean }) {
    const names = await fsp.readdir(p);
    const result: FileEntry[] = [];
    for (const name of names) {
      try {
        const s = await fsp.lstat(path.join(p, name));
        result.push({
          name,
          path: path.join(p, name),
          kind: kind(s),
          size: s.size,
          modified: s.mtimeMs,
          mode: s.mode,
        });
      } catch (error) {
        // Browsing may omit protected entries; recursive transfers remain strict.
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code !== "ENOENT" &&
          !(options?.skipUnreadable && ["EACCES", "EPERM"].includes(code ?? ""))
        )
          throw error;
      }
    }
    return result;
  }
  async stat(p: string): Promise<FileEntry | null> {
    try {
      const s = await fsp.lstat(p);
      return {
        name: path.basename(p),
        path: p,
        kind: kind(s),
        size: s.size,
        modified: s.mtimeMs,
        mode: s.mode,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  realpath(p: string) {
    return fsp.realpath(p);
  }
  async mkdir(p: string) {
    await fsp.mkdir(p);
  }
  rename(a: string, b: string) {
    return fsp.rename(a, b);
  }
  async remove(p: string) {
    const s = await fsp.lstat(p);
    if (s.isDirectory() && !s.isSymbolicLink())
      await fsp.rm(p, { recursive: true });
    else await fsp.unlink(p);
  }
  async chmod() {
    throw new Error("권한 변경은 SFTP에서만 지원합니다.");
  }
  async download(p: string, dest: Writable, signal: AbortSignal) {
    await pipeline(fs.createReadStream(p), dest, { signal });
  }
  async upload(p: string, source: Readable, signal: AbortSignal) {
    await pipeline(source, fs.createWriteStream(p, { flags: "wx" }), {
      signal,
    });
  }
  close() {
    this.connected = false;
  }
}
export class SFTPAdapter implements FileAdapter {
  connected = true;
  constructor(
    readonly endpoint: Endpoint,
    readonly client: Client,
    readonly sftp: SFTPWrapper,
  ) {
    client.on("close", () => {
      this.connected = false;
    });
  }
  normalize(p: string) {
    return path.posix.resolve("/", p || this.endpoint.initialPath);
  }
  join(p: string, n: string) {
    return path.posix.join(p, n);
  }
  parent(p: string) {
    return path.posix.dirname(p);
  }
  async list(p: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) =>
      this.sftp.readdir(p, (e, list) =>
        e
          ? reject(e)
          : resolve(
              list
                .filter((x) => x.filename !== "." && x.filename !== "..")
                .map((x) => ({
                  name: x.filename,
                  path: this.join(p, x.filename),
                  kind: x.attrs.isSymbolicLink()
                    ? "link"
                    : x.attrs.isDirectory()
                      ? "directory"
                      : "file",
                  size: x.attrs.size,
                  modified: x.attrs.mtime * 1000,
                  mode: x.attrs.mode,
                })),
            ),
      ),
    );
  }
  async stat(p: string): Promise<FileEntry | null> {
    return new Promise((resolve, reject) =>
      this.sftp.lstat(p, (e, s) =>
        e
          ? (e as Error & { code?: number }).code === 2
            ? resolve(null)
            : reject(e)
          : resolve({
              name: path.posix.basename(p),
              path: p,
              kind: s.isSymbolicLink()
                ? "link"
                : s.isDirectory()
                  ? "directory"
                  : "file",
              size: s.size,
              modified: s.mtime * 1000,
              mode: s.mode,
            }),
      ),
    );
  }
  async realpath(p: string): Promise<string> {
    return new Promise((resolve, reject) =>
      this.sftp.realpath(p, (e, result) => (e ? reject(e) : resolve(result))),
    );
  }
  async mkdir(p: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sftp.mkdir(p, (e) => (e ? reject(e) : resolve())),
    );
  }
  async rename(a: string, b: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sftp.rename(a, b, (e) => (e ? reject(e) : resolve())),
    );
  }
  async remove(p: string): Promise<void> {
    const s = await this.stat(p);
    if (!s) return;
    if (s.kind === "directory") {
      for (const child of await this.list(p)) await this.remove(child.path);
      await new Promise<void>((resolve, reject) =>
        this.sftp.rmdir(p, (e) => (e ? reject(e) : resolve())),
      );
    } else
      await new Promise<void>((resolve, reject) =>
        this.sftp.unlink(p, (e) => (e ? reject(e) : resolve())),
      );
  }
  async chmod(p: string, mode: number): Promise<void> {
    const s = await this.stat(p);
    if (!s || s.kind === "link")
      throw new Error("일반 파일 또는 폴더를 선택해 주세요.");
    await new Promise<void>((resolve, reject) =>
      this.sftp.chmod(p, ((s.mode ?? 0) & 0o7000) | (mode & 0o777), (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  }
  async download(p: string, dest: Writable, signal: AbortSignal) {
    await pipeline(this.sftp.createReadStream(p), dest, { signal });
  }
  async upload(p: string, source: Readable, signal: AbortSignal) {
    await pipeline(source, this.sftp.createWriteStream(p, { flags: "wx" }), {
      signal,
    });
  }
  close() {
    this.connected = false;
    this.sftp.end();
    this.client.end();
  }
}
export class FTPAdapter implements FileAdapter {
  connected = true;
  constructor(
    readonly endpoint: Endpoint,
    readonly ftp: FTP,
  ) {}
  normalize(p: string) {
    return path.posix.resolve("/", p || this.endpoint.initialPath);
  }
  join(p: string, n: string) {
    return path.posix.join(p, n);
  }
  parent(p: string) {
    return path.posix.dirname(p);
  }
  async list(p: string): Promise<FileEntry[]> {
    return (await this.ftp.list(p))
      .filter((x) => x.name !== "." && x.name !== "..")
      .map((x) => ({
        name: x.name,
        path: this.join(p, x.name),
        kind:
          x.type === FileType.Directory
            ? "directory"
            : x.type === FileType.SymbolicLink
              ? "link"
              : "file",
        size: x.size,
        modified: x.modifiedAt?.getTime() ?? 0,
      }));
  }
  async stat(p: string) {
    if (p === "/")
      return {
        name: "/",
        path: "/",
        kind: "directory" as const,
        size: 0,
        modified: 0,
      };
    return (
      (await this.list(this.parent(p))).find(
        (x) => x.name === path.posix.basename(p),
      ) ?? null
    );
  }
  async realpath(p: string) {
    const previous = await this.ftp.pwd();
    try {
      await this.ftp.cd(p);
      return await this.ftp.pwd();
    } finally {
      await this.ftp.cd(previous);
    }
  }
  async mkdir(p: string) {
    await this.ftp.send(`MKD ${p}`);
  }
  async rename(a: string, b: string) {
    await this.ftp.rename(a, b);
  }
  async remove(p: string) {
    const s = await this.stat(p);
    if (!s) return;
    if (s.kind === "directory") {
      for (const child of await this.list(p)) await this.remove(child.path);
      await this.ftp.send(`RMD ${p}`);
    } else await this.ftp.remove(p);
  }
  async chmod() {
    throw new Error("권한 변경은 SFTP에서만 지원합니다.");
  }
  private async transfer(task: () => Promise<unknown>, signal: AbortSignal) {
    const abort = () => {
      this.connected = false;
      this.ftp.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) {
        abort();
        throw new Error("전송 취소");
      }
      await task();
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async download(p: string, dest: Writable, signal: AbortSignal) {
    await this.transfer(() => this.ftp.downloadTo(dest, p), signal);
  }
  async upload(p: string, source: Readable, signal: AbortSignal) {
    await this.transfer(() => this.ftp.uploadFrom(source, p), signal);
  }
  close() {
    this.connected = false;
    this.ftp.close();
  }
}
// Reservations are acquired together, preventing opposite-direction transfers from deadlocking.
export class Reservations {
  private busy = new Set<string>();
  private waiters: (() => void)[] = [];
  async with<T>(ids: string[], task: () => Promise<T>): Promise<T> {
    const keys = [...new Set(ids)].sort();
    while (keys.some((k) => this.busy.has(k)))
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    keys.forEach((k) => this.busy.add(k));
    try {
      return await task();
    } finally {
      keys.forEach((k) => this.busy.delete(k));
      this.waiters.splice(0).forEach((w) => w());
    }
  }
}
export class Files {
  adapters = new Map<string, FileAdapter>();
  locks = new Reservations();
  constructor(
    readonly store: Store,
    readonly confirm: TrustPrompt,
    readonly onDetectedOS?: (host: Host, os: string) => void,
  ) {}
  async open(host: Host | null, secret?: Secret): Promise<Endpoint> {
    let adapter: FileAdapter;
    if (!host) adapter = new LocalAdapter();
    else {
      if (!secret) throw new Error("인증 정보를 입력해 주세요.");
      const protocol = host.protocol === "ssh" ? "sftp" : host.protocol;
      const endpoint: Endpoint = {
        id: randomUUID(),
        hostId: host.id,
        protocol,
        label: host.name,
        initialPath: host.startPath,
      };
      if (protocol === "sftp") {
        const config = {
          ...host,
          port: host.sftpPort ?? host.port,
          username: host.sftpUsername || host.username,
        };
        const client = await connectSSH(
          config,
          secret,
          this.store,
          this.confirm,
        );
        try {
          const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
            client.sftp((e, s) => (e ? reject(e) : resolve(s))),
          );
          adapter = new SFTPAdapter(endpoint, client, sftp);
          endpoint.initialPath =
            host.startPath || (await adapter.realpath("."));
          if (this.onDetectedOS)
            void detectRemoteOS(client)
              .then((os) => {
                if (os) this.onDetectedOS?.(host, os);
              })
              .catch(() => {});
        } catch (error) {
          client.end();
          throw error;
        }
      } else {
        if (secret.type !== "password")
          throw new Error("FTP는 비밀번호 인증을 사용합니다.");
        const ftp = new FTP(15000);
        try {
          await ftp.access({
            host: host.address,
            port: host.port,
            user: host.username,
            password: secret.password,
            secure: protocol === "ftps",
            secureOptions: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
          });
          endpoint.initialPath = host.startPath || (await ftp.pwd());
          adapter = new FTPAdapter(endpoint, ftp);
        } catch (error) {
          ftp.close();
          throw error;
        }
      }
    }
    this.adapters.set(adapter.endpoint.id, adapter);
    return adapter.endpoint;
  }
  get(id: string) {
    const a = this.adapters.get(id);
    if (!a || !a.connected)
      throw new Error("파일 연결이 종료되었습니다. 다시 연결해 주세요.");
    return a;
  }
  async list(id: string, p: string) {
    return this.locks.with([id], async () => {
      const a = this.get(id),
        normalized = a.normalize(p);
      return {
        path: normalized,
        entries: await a.list(normalized, { skipUnreadable: true }),
      };
    });
  }
  async action(
    id: string,
    action: string,
    paths: string[],
    name?: string,
    mode?: number,
  ) {
    return this.locks.with([id], async () => {
      const a = this.get(id);
      const normalized = paths.map((p) => a.normalize(p));
      if (!normalized.length) throw new Error("대상을 선택해 주세요.");
      if (action === "mkdir" || action === "touch" || action === "rename")
        if (!name || /[\/\\\r\n\0]/.test(name) || name === "." || name === "..")
          throw new Error("올바른 이름을 입력해 주세요.");
      if (action === "delete") {
        for (const p of normalized) {
          if (a.parent(p) === p)
            throw new Error("루트 폴더는 삭제할 수 없습니다.");
          await a.remove(p);
        }
        return;
      }
      if (normalized.length !== 1)
        throw new Error("하나의 항목을 선택해 주세요.");
      const p = normalized[0];
      if (action === "chmod") {
        if (mode === undefined) throw new Error("권한을 입력해 주세요.");
        await a.chmod(p, mode);
        return;
      }
      const target = a.join(action === "rename" ? a.parent(p) : p, name!);
      if (await a.stat(target)) throw new Error("같은 이름이 이미 있습니다.");
      if (action === "rename") await a.rename(p, target);
      else if (action === "mkdir") await a.mkdir(target);
      else if (action === "touch")
        await a.upload(target, Readable.from([]), new AbortController().signal);
    });
  }
  async close(id: string) {
    await this.locks.with([id], async () => {
      this.adapters.get(id)?.close();
      this.adapters.delete(id);
    });
  }
  closeAll() {
    for (const a of this.adapters.values()) a.close();
    this.adapters.clear();
  }
}
