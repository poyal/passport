import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Vault } from "../store";
import {
  shareSettingsSchema,
  shareEndpointSchema,
  shareLabel,
  type ShareSettings,
  type SharePeer,
  type ShareMessage,
} from "../../shared/share";
import {
  identitySchema,
  createIdentity,
  fingerprint,
  validateCertificate,
  type ShareIdentity,
} from "./identity";

const peerSchema = z
  .object({
    id: z.string(),
    name: shareLabel,
    endpoint: shareEndpointSchema,
    cert: z.string(),
  })
  .strict();
export type StoredPeer = SharePeer & { cert: string };
const messageSchema = z
  .object({
    id: z.string().uuid(),
    peerName: z.string(),
    created: z.number(),
    title: z.string(),
    markdown: z.string(),
    attachment: z
      .object({
        name: z.string(),
        path: z.string(),
        bytes: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();

export class ShareStore {
  private db: Database.Database;
  private identityValue?: ShareIdentity;
  private identityPending?: Promise<ShareIdentity>;
  private identityGeneration = 0;
  constructor(
    directory: string,
    private vault: Vault,
    private downloads: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "share.sqlite");
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("secure_delete = ON");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,created INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id));",
    );
    chmodSync(file, 0o600);
  }
  settings(): ShareSettings {
    const row = this.db
      .prepare("SELECT value FROM preferences WHERE id=1")
      .get() as { value: string } | undefined;
    return row
      ? shareSettingsSchema.parse(JSON.parse(row.value))
      : shareSettingsSchema.parse({
          receiveDirectory: path.join(this.downloads, "Passport"),
        });
  }
  saveSettings(input: ShareSettings) {
    const value = shareSettingsSchema.parse(input);
    this.db
      .prepare("INSERT OR REPLACE INTO preferences VALUES(1,?)")
      .run(JSON.stringify(value));
    this.prune();
    return value;
  }
  private put(kind: string, id: string, value: unknown, created = Date.now()) {
    if (!this.vault.isEncryptionAvailable())
      throw new Error(
        "암호화 저장소를 사용할 수 없습니다. 쪽지를 시작할 수 없습니다.",
      );
    const encrypted = this.vault.encryptString(JSON.stringify(value));
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)")
      .run(kind, id, created, encrypted);
  }
  private list(kind: string): unknown[] {
    const rows = this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY created DESC")
      .all(kind) as { data: Buffer }[];
    if (rows.length && !this.vault.isEncryptionAvailable())
      throw new Error("암호화 저장소를 사용할 수 없습니다.");
    return rows.map((row) => JSON.parse(this.vault.decryptString(row.data)));
  }
  async identity() {
    if (this.identityValue) return this.identityValue;
    if (this.identityPending) return this.identityPending;
    const generation = this.identityGeneration;
    const initialize = async () => {
      const records = this.list("identity");
      const value = records.length
        ? identitySchema.parse(records[0])
        : await createIdentity();
      if (generation !== this.identityGeneration)
        throw new Error("기기키 초기화가 취소되었습니다. 다시 시도하세요.");
      validateCertificate(value.cert);
      if (!records.length) this.put("identity", "self", value);
      this.identityValue = value;
      return value;
    };
    const pending = initialize().finally(() => {
      if (this.identityPending === pending) this.identityPending = undefined;
    });
    this.identityPending = pending;
    return pending;
  }
  peers() {
    return this.list("peer").flatMap((value) => {
      // 1.3.0 blocked contacts become deleted contacts when the encrypted
      // address book is unlocked. Never silently restore their trust.
      const { blocked, ...peer } = peerSchema
        .extend({ blocked: z.boolean().optional() })
        .parse(value);
      if (blocked) {
        this.removePeer(peer.id);
        return [];
      }
      if (blocked !== undefined) this.put("peer", peer.id, peer);
      return [peer];
    });
  }
  savePeer(peer: StoredPeer) {
    validateCertificate(peer.cert);
    if (fingerprint(peer.cert) !== peer.id)
      throw new Error("기기 인증서가 일치하지 않습니다.");
    this.put("peer", peer.id, peerSchema.parse(peer));
  }
  removePeer(id: string) {
    this.db.prepare("DELETE FROM records WHERE kind='peer' AND id=?").run(id);
  }
  resetIdentity() {
    this.db
      .prepare(
        "DELETE FROM records WHERE kind IN ('identity','peer','listener')",
      )
      .run();
    this.identityValue = undefined;
    this.identityGeneration++;
    this.identityPending = undefined;
  }
  listenerPort() {
    const value = this.list("listener")[0];
    return value
      ? z.object({ port: z.number().int().min(1).max(65535) }).parse(value).port
      : 0;
  }
  saveListenerPort(port: number) {
    this.put("listener", "self", { port });
  }
  async trackStaging(directory: string) {
    const stat = await fs.lstat(directory);
    const id = path.basename(directory);
    if (
      !/^\.passport-receive-[a-zA-Z0-9]+$/.test(id) ||
      !stat.isDirectory() ||
      stat.isSymbolicLink()
    )
      throw new Error("임시 저장 폴더가 올바르지 않습니다.");
    this.put("staging", id, { directory, ino: stat.ino, dev: stat.dev });
    return () =>
      this.db
        .prepare("DELETE FROM records WHERE kind='staging' AND id=?")
        .run(id);
  }
  async recoverStaging() {
    for (const raw of this.list("staging")) {
      const item = z
        .object({ directory: z.string(), ino: z.number(), dev: z.number() })
        .strict()
        .parse(raw);
      const id = path.basename(item.directory);
      if (
        !path.isAbsolute(item.directory) ||
        !/^\.passport-receive-[a-zA-Z0-9]+$/.test(id)
      )
        throw new Error("임시 파일 복구 기록이 올바르지 않습니다.");
      const stat = await fs.lstat(item.directory).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat) {
        if (
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          stat.ino !== item.ino ||
          stat.dev !== item.dev ||
          (await fs.realpath(item.directory)) !== item.directory
        )
          throw new Error("임시 폴더가 변경되어 자동 정리할 수 없습니다.");
        await fs.rm(item.directory, { recursive: true });
      }
      this.db
        .prepare("DELETE FROM records WHERE kind='staging' AND id=?")
        .run(id);
    }
  }
  messages() {
    this.prune();
    const rows = this.db
      .prepare(
        "SELECT data FROM records WHERE kind='message' ORDER BY created DESC LIMIT 100",
      )
      .all() as { data: Buffer }[];
    return rows.map((row) => {
      const { markdown: _, ...summary } = messageSchema.parse(
        JSON.parse(this.vault.decryptString(row.data)),
      );
      return summary;
    });
  }
  message(id: string) {
    this.prune();
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind='message' AND id=?")
      .get(id) as { data: Buffer } | undefined;
    if (!row) throw new Error("쪽지가 없거나 보관 기간이 지났습니다.");
    return messageSchema.parse(JSON.parse(this.vault.decryptString(row.data)));
  }
  addMessage(message: ShareMessage) {
    const total = this.db
      .prepare(
        "SELECT SUM(length(data)) AS bytes FROM records WHERE kind='message'",
      )
      .get() as { bytes: number | null };
    if ((total.bytes ?? 0) + Buffer.byteLength(message.markdown) > 1024 ** 3)
      throw new Error("쪽지가 1 GiB를 초과했습니다. 쪽지를 정리해 주세요.");
    this.put(
      "message",
      message.id,
      messageSchema.parse(message),
      message.created,
    );
  }
  removeMessage(id: string) {
    this.db
      .prepare("DELETE FROM records WHERE kind='message' AND id=?")
      .run(id);
  }
  prune() {
    const days = this.settings().retentionDays;
    return days !== null
      ? this.db
          .prepare("DELETE FROM records WHERE kind='message' AND created < ?")
          .run(Date.now() - days * 86400000).changes
      : 0;
  }
  close() {
    this.identityValue = undefined;
    this.identityGeneration++;
    this.identityPending = undefined;
    this.db.close();
  }
}
