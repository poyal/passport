import Database from "better-sqlite3";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import {
  documentSchema,
  emptyDocument,
  secretSchema,
  profileUsernameSchema,
  type PassportDocument,
  type AuthProfile,
  type Secret,
} from "../shared/model";
import { packageSchema, safeJson, type Portable } from "./portable";
export interface Vault {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export class Store {
  db: Database.Database;
  constructor(
    readonly directory: string,
    readonly vault: Vault,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(directory, "passport.sqlite"));
    const version = Number(this.db.pragma("user_version", { simple: true }));
    if (version > 3) {
      this.db.close();
      throw new Error("더 새로운 Passport 버전에서 만든 데이터베이스입니다.");
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, secret BLOB); CREATE TABLE IF NOT EXISTS known_hosts (address TEXT NOT NULL, port INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(address,port));",
    );
    if (
      !(this.db.pragma("table_info(credentials)") as { name: string }[]).some(
        (c) => c.name === "username",
      )
    )
      this.db.exec(
        "ALTER TABLE credentials ADD COLUMN username TEXT NOT NULL DEFAULT ''",
      );
    if (version < 3) {
      const metadata = this.db
        .prepare("SELECT value FROM metadata WHERE id=1")
        .get() as { value: string } | undefined;
      if (metadata) {
        const document = documentSchema.parse(JSON.parse(metadata.value));
        for (const host of document.hosts)
          if (host.icon === "server") host.icon = "auto";
        this.db
          .prepare("UPDATE metadata SET value=? WHERE id=1")
          .run(JSON.stringify(document));
      }
    }
    this.db.pragma("user_version = 3");
    if (!this.db.prepare("SELECT id FROM metadata").get())
      this.save(emptyDocument());
    chmodSync(path.join(directory, "passport.sqlite"), 0o600);
  }
  read(): PassportDocument {
    return documentSchema.parse(
      JSON.parse(
        (
          this.db.prepare("SELECT value FROM metadata WHERE id=1").get() as {
            value: string;
          }
        ).value,
      ),
    );
  }
  save(document: PassportDocument): PassportDocument {
    const valid = documentSchema.parse(document);
    const current = this.db
      .prepare("SELECT value FROM metadata WHERE id=1")
      .get() as { value: string } | undefined;
    valid.revision =
      (current ? JSON.parse(current.value).revision || 0 : 0) + 1;
    const ids = new Set(this.profiles().map((p) => p.id));
    for (const g of valid.groups)
      if (g.defaults.authId && !ids.has(g.defaults.authId))
        throw new Error("그룹 인증 프로필을 찾을 수 없습니다.");
    for (const h of valid.hosts)
      if (
        (h.authId && !ids.has(h.authId)) ||
        (h.sftpAuthId && !ids.has(h.sftpAuthId))
      )
        throw new Error("인증 프로필을 찾을 수 없습니다.");
    this.db
      .prepare(
        "INSERT INTO metadata(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(valid));
    return valid;
  }
  profiles(): AuthProfile[] {
    return (
      this.db
        .prepare(
          "SELECT id,name,type,username,secret IS NOT NULL AS hasSecret FROM credentials ORDER BY name",
        )
        .all() as (Omit<AuthProfile, "hasSecret"> & { hasSecret: number })[]
    ).map((p) => ({ ...p, hasSecret: !!p.hasSecret }));
  }
  saveSecret(
    id: string,
    name: string,
    raw: Secret,
    username = "",
  ): AuthProfile[] {
    if (!this.vault.isEncryptionAvailable())
      throw new Error(
        "이 기기에서 암호화 저장을 사용할 수 없습니다. 이번 연결에만 입력해 주세요.",
      );
    username = profileUsernameSchema.parse(username);
    const secret = secretSchema.parse(raw),
      encrypted = this.vault.encryptString(JSON.stringify(secret));
    this.db
      .prepare(
        "INSERT INTO credentials(id,name,type,secret,username) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,secret=excluded.secret,username=excluded.username",
      )
      .run(id, name, secret.type, encrypted, username);
    return this.profiles();
  }
  getSecret(id: string | null): Secret | undefined {
    if (!id) return undefined;
    const row = this.db
      .prepare("SELECT secret FROM credentials WHERE id=?")
      .get(id) as { secret: Buffer | null } | undefined;
    return row?.secret
      ? secretSchema.parse(JSON.parse(this.vault.decryptString(row.secret)))
      : undefined;
  }
  deleteSecret(id: string): AuthProfile[] {
    if (
      this.read().hosts.some((h) => h.authId === id || h.sftpAuthId === id) ||
      this.read().groups.some((g) => g.defaults.authId === id)
    )
      throw new Error(
        "사용 중인 인증 프로필입니다. 호스트에서 연결을 해제해 주세요.",
      );
    this.db.prepare("DELETE FROM credentials WHERE id=?").run(id);
    return this.profiles();
  }
  fingerprint(address: string, port: number): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT fingerprint FROM known_hosts WHERE address=? AND port=?",
        )
        .get(address, port) as { fingerprint: string } | undefined
    )?.fingerprint;
  }
  trust(address: string, port: number, fingerprint: string) {
    this.db
      .prepare(
        "INSERT INTO known_hosts(address,port,fingerprint) VALUES(?,?,?) ON CONFLICT(address,port) DO UPDATE SET fingerprint=excluded.fingerprint",
      )
      .run(address, port, fingerprint);
  }
  portable(includeSecrets = false): Portable {
    const result: Portable = {
      format: "passport",
      version: 1,
      document: this.read(),
      profiles: this.profiles(),
    };
    if (includeSecrets) {
      result.secrets = {};
      for (const profile of result.profiles) {
        const secret = this.getSecret(profile.id);
        if (secret) result.secrets[profile.id] = secret;
      }
    }
    return result;
  }
  apply(
    document: PassportDocument,
    profiles: AuthProfile[],
    secrets: Record<string, Secret>,
  ) {
    this.db.transaction(() => {
      for (const p of profiles)
        this.db
          .prepare(
            "INSERT INTO credentials(id,name,type,username) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, secret=CASE WHEN credentials.type=excluded.type THEN credentials.secret ELSE NULL END, type=excluded.type,username=excluded.username",
          )
          .run(
            p.id,
            p.name,
            p.type,
            profileUsernameSchema.parse(p.username ?? ""),
          );
      for (const [id, s] of Object.entries(secrets)) {
        const p = profiles.find((x) => x.id === id);
        if (p) this.saveSecret(id, p.name, s, p.username);
      }
      this.save(document);
    })();
  }
  backup() {
    const folder = path.join(this.directory, "backups");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().slice(0, 10)}.json`,
      file = path.join(folder, name);
    if (!this.backups().includes(name)) {
      const credentials = this.db
        .prepare("SELECT id,secret FROM credentials")
        .all() as { id: string; secret: Buffer | null }[];
      writeFileSync(
        file,
        JSON.stringify({
          ...this.portable(),
          localSecrets: Object.fromEntries(
            credentials
              .filter((r) => r.secret)
              .map((r) => [r.id, r.secret!.toString("base64")]),
          ),
        }),
        { mode: 0o600 },
      );
    }
    for (const old of this.backups().slice(7))
      unlinkSync(path.join(folder, old));
  }
  backups(): string[] {
    try {
      return readdirSync(path.join(this.directory, "backups"))
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
  readBackup(name: string): Portable {
    if (!this.backups().includes(name))
      throw new Error("백업을 찾을 수 없습니다.");
    const raw = safeJson(
      readFileSync(path.join(this.directory, "backups", name), "utf8"),
    ) as { localSecrets?: Record<string, string> };
    const portable = packageSchema.parse(raw);
    portable.secrets = {};
    for (const [id, value] of Object.entries(raw.localSecrets ?? {}))
      portable.secrets[id] = secretSchema.parse(
        JSON.parse(this.vault.decryptString(Buffer.from(value, "base64"))),
      );
    return portable;
  }
  close() {
    this.db.close();
  }
}
