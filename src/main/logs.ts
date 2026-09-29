import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { LogFile } from "../shared/model";
export class SessionLogs {
  active = new Map<string, string>();
  private lastPrune = 0;
  private chunkLimit = 16 * 1024 ** 2;
  readonly folder: string;
  constructor(
    readonly store: Store,
    readonly onError: (message: string) => void = () => {},
  ) {
    this.folder = path.join(store.directory, "logs");
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS session_logs(id TEXT PRIMARY KEY, name TEXT NOT NULL, started INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, bookmarks TEXT NOT NULL DEFAULT "[]"); CREATE TABLE IF NOT EXISTS command_history(text TEXT PRIMARY KEY, used INTEGER NOT NULL);',
    );
    this.prune();
  }
  start(session: string, name: string) {
    if (this.active.has(session)) return;
    const id = randomUUID();
    fs.writeFileSync(this.file(id), "", { mode: 0o600 });
    this.store.db
      .prepare("INSERT INTO session_logs(id,name,started) VALUES(?,?,?)")
      .run(id, name, Date.now());
    this.active.set(session, id);
  }
  stop(session: string) {
    this.active.delete(session);
  }
  append(session: string, data: string) {
    let id = this.active.get(session);
    if (!id) return;
    try {
      const row = this.get(id);
      if (row.bytes && row.bytes + Buffer.byteLength(data) > this.chunkLimit) {
        this.stop(session);
        this.start(session, row.name);
        id = this.active.get(session)!;
      }
      fs.appendFileSync(this.file(id), data);
      this.store.db
        .prepare("UPDATE session_logs SET bytes=bytes+? WHERE id=?")
        .run(Buffer.byteLength(data), id);
      if (Date.now() - this.lastPrune > 1000) this.prune();
    } catch (error) {
      this.active.delete(session);
      this.onError(
        `세션 로그 기록이 중단되었습니다: ${error instanceof Error ? error.message : "저장 오류"}`,
      );
    }
  }
  private file(id: string) {
    return path.join(this.folder, `${id}.log`);
  }
  list(): LogFile[] {
    this.prune();
    return (
      this.store.db
        .prepare("SELECT * FROM session_logs ORDER BY started DESC")
        .all() as {
        id: string;
        name: string;
        started: number;
        bytes: number;
        bookmarks: string;
      }[]
    ).map((r) => ({
      ...r,
      recording: [...this.active.values()].includes(r.id),
      sessionId: [...this.active].find(([, id]) => id === r.id)?.[0],
      bookmarks: JSON.parse(r.bookmarks),
    }));
  }
  get(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM session_logs WHERE id=?")
      .get(id) as
      | {
          id: string;
          name: string;
          started: number;
          bytes: number;
          bookmarks: string;
        }
      | undefined;
    if (!row) throw new Error("로그를 찾을 수 없습니다.");
    return row;
  }
  read(id: string, offset = 0, query = "") {
    const row = this.get(id);
    let cursor = Math.min(offset, row.bytes);
    const buffer = Buffer.alloc(262144),
      fd = fs.openSync(this.file(id), "r");
    let text = "",
      matches: number[] = [];
    try {
      do {
        const size = fs.readSync(fd, buffer, 0, buffer.length, cursor);
        if (!size) break;
        text = buffer.subarray(0, size).toString("utf8");
        const found = query
          ? text.toLowerCase().indexOf(query.toLowerCase())
          : 0;
        if (found >= 0) {
          if (query)
            matches.push(cursor + Buffer.byteLength(text.slice(0, found)));
          return { text, offset: cursor, next: cursor + size, matches };
        }
        if (cursor + size >= row.bytes) {
          cursor = row.bytes;
          break;
        }
        cursor += Math.max(1, size - Math.min(4096, Buffer.byteLength(query))); // retain search overlap across chunks
      } while (cursor < row.bytes && cursor - offset < 16 * 1024 * 1024);
      return { text: "", offset: cursor, next: cursor, matches };
    } finally {
      fs.closeSync(fd);
    }
  }
  bookmark(id: string, offset: number, label: string) {
    const row = this.get(id),
      marks = JSON.parse(row.bookmarks) as LogFile["bookmarks"];
    if (marks.length >= 500) throw new Error("북마크는 최대 500개입니다.");
    marks.push({ offset: Math.min(offset, row.bytes), label });
    this.store.db
      .prepare("UPDATE session_logs SET bookmarks=? WHERE id=?")
      .run(JSON.stringify(marks), id);
  }
  export(id: string, destination: string) {
    this.get(id);
    fs.copyFileSync(this.file(id), destination);
  }
  delete(id: string) {
    this.get(id);
    for (const [session, log] of this.active)
      if (log === id) this.active.delete(session);
    fs.rmSync(this.file(id), { force: true });
    this.store.db.prepare("DELETE FROM session_logs WHERE id=?").run(id);
  }
  prune() {
    this.lastPrune = Date.now();
    const settings = this.store.read().settings;
    this.chunkLimit = Math.min(
      16 * 1024 ** 2,
      (settings.logLimitMiB * 1024 ** 2) / 4,
    );
    const rows = this.store.db
      .prepare(
        "SELECT id,name,started,bytes FROM session_logs ORDER BY started DESC, rowid DESC",
      )
      .all() as { id: string; name: string; started: number; bytes: number }[];
    let total = 0;
    for (const r of rows) {
      if (
        Date.now() - r.started > settings.logRetentionDays * 86400000 ||
        total + r.bytes > settings.logLimitMiB * 1024 ** 2
      ) {
        const recording = [...this.active]
          .filter(([, id]) => id === r.id)
          .map(([session]) => session);
        this.delete(r.id);
        for (const session of recording) this.start(session, r.name);
      } else total += r.bytes;
    }
  }
  remember(text: string) {
    this.store.db
      .prepare(
        "INSERT INTO command_history(text,used) VALUES(?,?) ON CONFLICT(text) DO UPDATE SET used=excluded.used",
      )
      .run(text, Date.now());
    this.store.db.exec(
      "DELETE FROM command_history WHERE text NOT IN (SELECT text FROM command_history ORDER BY used DESC LIMIT 200)",
    );
  }
  history(query: string) {
    return (
      this.store.db
        .prepare(
          "SELECT text FROM command_history ORDER BY used DESC LIMIT 200",
        )
        .all() as { text: string }[]
    )
      .filter((r) => r.text.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 30)
      .map((r) => r.text);
  }
}
