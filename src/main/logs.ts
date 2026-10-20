import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { LogTextDecoder } from "./log-text";
import type { Store } from "./store";
import {
  logReasons,
  type LogFile,
  type LogGroup,
  type LogCursor,
  type LogPage,
  type LogReason,
} from "../shared/model";
export class SessionLogs {
  active = new Map<string, string>();
  private connections = new Map<
    string,
    {
      groupId?: string;
      reason: LogReason;
      connected: boolean;
      fingerprint?: string;
    }
  >();
  private lastPrune = 0;
  private chunkLimit = 16 * 1024 ** 2;
  private retentionMs = 30 * 86400000;
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
  beginConnection(session: string, groupId?: string, fingerprint?: string) {
    this.stop(session);
    const existing =
      groupId &&
      this.store.db
        .prepare("SELECT id FROM session_log_groups WHERE id=?")
        .get(groupId);
    this.connections.set(session, {
      groupId: existing ? groupId : undefined,
      reason: existing ? "resume" : "start",
      connected: false,
      fingerprint,
    });
  }
  connected(session: string, fingerprint?: string) {
    if (!this.connections.has(session)) this.beginConnection(session);
    const connection = this.connections.get(session)!;
    if (connection.fingerprint && connection.fingerprint !== fingerprint) {
      connection.groupId = undefined;
      connection.reason = "start";
      connection.connected = false;
    }
    connection.fingerprint = fingerprint;
    if (connection.connected) connection.reason = "reconnect";
    connection.connected = true;
  }
  groupFor(session: string) {
    return this.connections.get(session)?.groupId;
  }
  forgetConnection(session: string) {
    this.stop(session);
    this.connections.delete(session);
  }
  retainConnections(ids: Set<string>) {
    for (const id of this.connections.keys())
      if (!ids.has(id)) this.forgetConnection(id);
  }
  start(session: string, name: string, reason?: LogReason) {
    if (this.active.has(session)) return;
    if (!this.connections.has(session)) this.beginConnection(session);
    const connection = this.connections.get(session)!;
    const id = randomUUID();
    fs.writeFileSync(this.file(id), "", { mode: 0o600 });
    try {
      this.store.db.transaction(() => {
        const now = Date.now();
        let group =
          connection.groupId &&
          (this.store.db
            .prepare(
              "SELECT id,next_ordinal FROM session_log_groups WHERE id=?",
            )
            .get(connection.groupId) as
            { id: string; next_ordinal: number } | undefined);
        if (!group) {
          group = { id: randomUUID(), next_ordinal: 0 };
          this.store.db
            .prepare(
              "INSERT INTO session_log_groups(id,name,started) VALUES(?,?,?)",
            )
            .run(group.id, name, now);
        }
        this.store.db
          .prepare("INSERT INTO session_logs(id,name,started) VALUES(?,?,?)")
          .run(id, name, now);
        this.store.db
          .prepare(
            "INSERT INTO session_log_segments(id,group_id,ordinal,reason) VALUES(?,?,?,?)",
          )
          .run(id, group.id, group.next_ordinal, reason ?? connection.reason);
        this.store.db
          .prepare(
            "UPDATE session_log_groups SET name=?,next_ordinal=next_ordinal+1 WHERE id=?",
          )
          .run(name, group.id);
        connection.groupId = group.id;
      })();
    } catch (error) {
      fs.rmSync(this.file(id), { force: true });
      throw error;
    }
    connection.reason = "recording";
    this.active.set(session, id);
  }
  stop(session: string) {
    const id = this.active.get(session);
    if (id)
      this.store.db
        .prepare("UPDATE session_log_segments SET ended=? WHERE id=?")
        .run(Date.now(), id);
    this.active.delete(session);
  }
  append(session: string, data: string) {
    let id = this.active.get(session);
    if (!id) return;
    try {
      if (Date.now() - this.lastPrune > 1000) {
        this.prune();
        id = this.active.get(session);
        if (!id) return;
      }
      let row = this.get(id);
      if (Date.now() - row.started > this.retentionMs) {
        this.prune();
        id = this.active.get(session);
        if (!id) return;
        row = this.get(id);
      }
      if (row.bytes && row.bytes + Buffer.byteLength(data) > this.chunkLimit) {
        this.stop(session);
        this.start(session, row.name, "rotation");
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
        .prepare(
          "SELECT l.*,s.group_id AS groupId,s.ordinal,s.reason,s.ended FROM session_logs l JOIN session_log_segments s USING(id) ORDER BY l.started DESC,l.rowid DESC",
        )
        .all() as {
        id: string;
        name: string;
        started: number;
        bytes: number;
        bookmarks: string;
        groupId: string;
        ordinal: number;
        reason: LogReason;
        ended: number | null;
      }[]
    ).map((r) => ({
      ...r,
      ended: r.ended ?? undefined,
      recording: [...this.active.values()].includes(r.id),
      sessionId: [...this.active].find(([, id]) => id === r.id)?.[0],
      bookmarks: JSON.parse(r.bookmarks),
    }));
  }
  groups(): LogGroup[] {
    const segments = this.list();
    const groups = new Map<string, LogGroup>();
    for (const row of this.store.db
      .prepare("SELECT id,name,started,expired,removed FROM session_log_groups")
      .all() as {
      id: string;
      name: string;
      started: number;
      expired: number;
      removed: number;
    }[])
      groups.set(row.id, {
        ...row,
        updated: row.started,
        bytes: 0,
        recording: false,
        segments: [],
      });
    for (const segment of segments) {
      const group = groups.get(segment.groupId)!;
      group.segments.push(segment);
      group.bytes += segment.bytes;
      group.recording ||= segment.recording;
      group.updated = Math.max(group.updated, segment.ended ?? segment.started);
    }
    return [...groups.values()]
      .filter((g) => g.segments.length)
      .map((g) => ({
        ...g,
        segments: g.segments.sort((a, b) => a.ordinal - b.ordinal),
      }))
      .sort((a, b) => b.updated - a.updated);
  }
  group(id: string) {
    const group = this.groups().find((g) => g.id === id);
    if (!group) throw new Error("로그 묶음을 찾을 수 없습니다.");
    return group;
  }
  readGroup(
    id: string,
    cursor: LogCursor = { ordinal: 0, offset: 0 },
    query = "",
  ): LogPage {
    const group = this.group(id);
    const page: LogPage = { parts: [], next: cursor, done: true };
    let displayed = 0,
      scanned = 0,
      count = 0;
    for (const segment of group.segments.filter(
      (s) => s.ordinal >= cursor.ordinal,
    )) {
      const offset =
        segment.ordinal === cursor.ordinal
          ? Math.min(cursor.offset, segment.bytes)
          : 0;
      const result = this.read(segment.id, offset, query, true);
      scanned += result.next; // Plain decoding starts at the segment's beginning to retain control state.
      if (result.text || (!query && !offset && !segment.bytes)) {
        page.parts.push({
          segmentId: segment.id,
          ordinal: segment.ordinal,
          offset: result.matches[0] ?? result.offset,
          text: result.text,
          started: segment.started,
          reason: segment.reason,
        });
        displayed += Buffer.byteLength(result.text);
      }
      page.next = { ordinal: segment.ordinal, offset: result.next };
      page.done =
        result.next >= segment.bytes && segment === group.segments.at(-1);
      if (
        result.next < segment.bytes ||
        (query && result.text) ||
        displayed >= 262144 ||
        scanned >= 16 * 1024 ** 2 ||
        ++count >= 64
      )
        break;
    }
    return page;
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
  read(id: string, offset = 0, query = "", plain = false) {
    if (plain) return this.readPlain(id, offset, query);
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
  private readPlain(id: string, offset: number, query: string) {
    const row = this.get(id),
      from = Math.min(offset, row.bytes);
    const utf8 = new StringDecoder("utf8"),
      filter = new LogTextDecoder(from, !!query);
    const buffer = Buffer.alloc(262144),
      fd = fs.openSync(this.file(id), "r");
    let cursor = 0,
      decoded = 0,
      tail = "",
      tailOffsets: number[] = [];
    try {
      while (cursor < row.bytes && cursor < from + 16 * 1024 * 1024) {
        const size = fs.readSync(fd, buffer, 0, buffer.length, cursor);
        if (!size) break;
        cursor += size;
        const source = utf8.write(buffer.subarray(0, size));
        const clean = filter.write(source, decoded);
        decoded += Buffer.byteLength(source);
        if (decoded <= from || !clean.text) continue;
        const text = tail + clean.text;
        if (!query)
          return {
            text,
            offset: Math.max(from, decoded - Buffer.byteLength(source)),
            next: decoded,
            matches: [] as number[],
          };
        const offsets = tailOffsets.concat(clean.offsets);
        const found = text.toLowerCase().indexOf(query.toLowerCase());
        if (found >= 0)
          return {
            text,
            offset: offsets[0],
            next: decoded,
            matches: [offsets[found]],
          };
        const overlap = Math.max(
          0,
          text.length - Math.max(0, query.length - 1),
        );
        tail = text.slice(overlap);
        tailOffsets = offsets.slice(overlap);
      }
      return {
        text: "",
        offset: decoded,
        next: decoded,
        matches: [] as number[],
      };
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
  async exportGroup(id: string, destination: string) {
    const group = this.group(id);
    // Commit a complete export atomically, without truncating existing files on failure.
    const target = path.resolve(destination);
    if (fs.realpathSync(path.dirname(target)) === fs.realpathSync(this.folder))
      throw new Error("로그 저장 폴더 밖으로 내보내세요.");
    const temporary = path.join(
      path.dirname(target),
      `.passport-log-${randomUUID()}.tmp`,
    );
    const output = await fs.promises.open(temporary, "wx", 0o600);
    try {
      await output.writeFile(
        `Passport · ${group.name}\n만료된 구간: ${group.expired} · 삭제된 구간: ${group.removed}\n`,
      );
      const buffer = Buffer.alloc(262144);
      for (const segment of group.segments) {
        await output.writeFile(
          `\r\n--- ${new Date(segment.started).toISOString()} · ${logReasons[segment.reason]} ---\r\n`,
        );
        const input = await fs.promises.open(this.file(segment.id), "r");
        try {
          let offset = 0;
          while (offset < segment.bytes) {
            const { bytesRead } = await input.read(
              buffer,
              0,
              Math.min(buffer.length, segment.bytes - offset),
              offset,
            );
            if (!bytesRead)
              throw new Error(
                "로그 구간을 모두 읽지 못했습니다. 목록을 새로고침한 뒤 다시 내보내세요.",
              );
            await output.writeFile(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
        } finally {
          await input.close();
        }
      }
      await output.close();
      await fs.promises.rename(temporary, target);
    } finally {
      await output.close().catch(() => {});
      await fs.promises.rm(temporary, { force: true });
    }
  }
  deleteGroup(id: string) {
    const group = this.group(id);
    for (const segment of group.segments) this.delete(segment.id);
    for (const connection of this.connections.values())
      if (connection.groupId === id) {
        connection.groupId = undefined;
        connection.reason = "recording";
      }
    this.store.db.prepare("DELETE FROM session_log_groups WHERE id=?").run(id);
  }
  delete(id: string, expired = false) {
    this.get(id);
    const segment = this.store.db
      .prepare("SELECT group_id FROM session_log_segments WHERE id=?")
      .get(id) as { group_id: string };
    for (const [session, log] of this.active)
      if (log === id) this.active.delete(session);
    fs.rmSync(this.file(id), { force: true });
    this.store.db.prepare("DELETE FROM session_logs WHERE id=?").run(id);
    this.store.db
      .prepare(
        `UPDATE session_log_groups SET ${expired ? "expired=expired+1" : "removed=removed+1"} WHERE id=?`,
      )
      .run(segment.group_id);
  }
  prune() {
    this.lastPrune = Date.now();
    const settings = this.store.read().settings;
    this.retentionMs = settings.logRetentionDays * 86400000;
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
        this.delete(r.id, true);
        for (const session of recording)
          this.start(session, r.name, "retention");
      } else total += r.bytes;
    }
    const retained = new Set(
      [...this.connections.values()].map((c) => c.groupId),
    );
    for (const row of this.store.db
      .prepare(
        "SELECT json_extract(value, '$.logGroup') AS id FROM session_resume WHERE json_valid(value)",
      )
      .all() as { id: string | null }[])
      if (row.id) retained.add(row.id);
    for (const row of this.store.db
      .prepare(
        "SELECT id FROM session_log_groups WHERE id NOT IN (SELECT group_id FROM session_log_segments)",
      )
      .all() as { id: string }[])
      if (!retained.has(row.id))
        this.store.db
          .prepare("DELETE FROM session_log_groups WHERE id=?")
          .run(row.id);
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
