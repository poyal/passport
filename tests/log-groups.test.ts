import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { SessionLogs } from "../src/main/logs";

const vault = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw Error("unused");
  },
  decryptString: () => {
    throw Error("unused");
  },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const clean of cleanups.splice(0)) clean();
});
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "passport-log-groups-"),
  );
  let store = new Store(directory, vault);
  cleanups.push(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get store() {
      return store;
    },
    logs: new SessionLogs(store),
    reopen() {
      store.close();
      store = new Store(directory, vault);
      return new SessionLogs(store);
    },
  };
}

it("joins an explicitly restored terminal across app restart without merging equal names or a new terminal", () => {
  const f = fixture();
  f.logs.beginConnection("pane");
  f.logs.connected("pane");
  f.logs.start("pane", "same host");
  f.logs.append("pane", "before\n");
  const group = f.logs.groupFor("pane")!;
  f.logs.stop("pane");
  const logs = f.reopen();
  logs.beginConnection("pane", group);
  logs.connected("pane");
  logs.start("pane", "same host");
  logs.append("pane", "after\n");
  expect(logs.group(group).segments.map((s) => s.reason)).toEqual([
    "start",
    "resume",
  ]);
  expect(logs.readGroup(group).parts.map((p) => p.text)).toEqual([
    "before\n",
    "after\n",
  ]);
  logs.beginConnection("new-pane");
  logs.start("new-pane", "same host");
  expect(logs.groupFor("new-pane")).not.toBe(group);
  logs.beginConnection("pane"); // A fresh connection without resume metadata.
  logs.start("pane", "same host");
  expect(logs.groups()).toHaveLength(3);
});

it("keeps automatic reconnects together but separates a changed SSH fingerprint", () => {
  const { logs } = fixture();
  logs.beginConnection("ssh");
  logs.connected("ssh", "key-a");
  logs.start("ssh", "server");
  const group = logs.groupFor("ssh")!;
  logs.stop("ssh");
  logs.connected("ssh", "key-a");
  logs.start("ssh", "server");
  expect(logs.group(group).segments.map((s) => s.reason)).toEqual([
    "start",
    "reconnect",
  ]);
  logs.stop("ssh");
  logs.connected("ssh", "key-b");
  logs.start("ssh", "server");
  expect(logs.groupFor("ssh")).not.toBe(group);
});

it("does not collect unrecorded output and labels recording gaps", () => {
  const { logs } = fixture();
  logs.beginConnection("pane");
  logs.connected("pane");
  logs.append("pane", "never recorded");
  expect(logs.groups()).toEqual([]);
  logs.start("pane", "local");
  logs.append("pane", "first");
  logs.stop("pane");
  logs.append("pane", "private gap");
  logs.start("pane", "local");
  logs.append("pane", "second");
  const group = logs.groups()[0];
  expect(group.segments.map((s) => s.reason)).toEqual(["start", "recording"]);
  expect(
    logs
      .readGroup(group.id)
      .parts.map((s) => s.text)
      .join(""),
  ).toBe("firstsecond");
  expect(group.segments[0].ended).toBeTypeOf("number");
});

it("searches later segments, preserves raw-byte bookmarks and exports either scope", async () => {
  const { directory, logs } = fixture();
  logs.start("pane", "work");
  const before = "old\x1b[31m 한글\x1b[0m\r\n";
  logs.append("pane", before);
  logs.stop("pane");
  logs.connected("pane");
  logs.start("pane", "work");
  const after = "prefix\r\n새로운\x1b[32m검색\x1b[0m\r\n";
  logs.append("pane", after);
  const group = logs.groups()[0];
  const result = logs.readGroup(group.id, undefined, "새로운검색");
  expect(result.parts).toHaveLength(1);
  expect(result.parts[0].segmentId).toBe(group.segments[1].id);
  expect(result.parts[0].offset).toBe(Buffer.byteLength("prefix\r\n"));
  logs.bookmark(result.parts[0].segmentId, result.parts[0].offset, "saved");
  expect(
    logs.readGroup(group.id, { ordinal: 1, offset: result.parts[0].offset })
      .parts[0].text,
  ).toBe("새로운검색\n");
  logs.export(group.segments[1].id, path.join(directory, "segment.log"));
  expect(fs.readFileSync(path.join(directory, "segment.log"), "utf8")).toBe(
    after,
  );
  const exporting = logs.exportGroup(
    group.id,
    path.join(directory, "group.log"),
  );
  logs.append("pane", "output after export started");
  await exporting;
  const output = fs.readFileSync(path.join(directory, "group.log"), "utf8");
  expect(output).toContain(before);
  expect(output).toContain(after);
  expect(output.indexOf(before)).toBeLessThan(output.indexOf(after));
  expect(output).toContain("기록 시작");
  expect(output).not.toContain("output after export started");
  await expect(
    logs.exportGroup(
      group.id,
      path.join(logs.folder, group.segments[0].id + ".log"),
    ),
  ).rejects.toThrow("저장 폴더 밖");
  expect(logs.read(group.segments[0].id).text).toBe(before);
});

it("leaves the destination intact and removes its temporary file when group export fails", async () => {
  const { directory, logs } = fixture();
  logs.start("pane", "work");
  logs.append("pane", "original");
  logs.stop("pane");
  const group = logs.groups()[0];
  const destination = path.join(directory, "keep.log");
  fs.writeFileSync(destination, "existing export");
  fs.unlinkSync(path.join(logs.folder, group.segments[0].id + ".log"));
  await expect(logs.exportGroup(group.id, destination)).rejects.toThrow();
  expect(fs.readFileSync(destination, "utf8")).toBe("existing export");
  expect(
    fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
});

it("paginates across segments and resumes a saved cursor after an older segment expires", () => {
  const { store, logs } = fixture();
  logs.start("pane", "work");
  logs.append("pane", "x".repeat(262144) + "first-tail\n");
  logs.stop("pane");
  logs.start("pane", "work");
  logs.append("pane", "last\n");
  const group = logs.groups()[0];
  const first = logs.readGroup(group.id);
  expect(first.done).toBe(false);
  expect(first.next).toEqual({ ordinal: 0, offset: 262144 });
  const next = logs.readGroup(group.id, first.next);
  expect(next.parts.map((p) => p.text)).toEqual(["first-tail\n", "last\n"]);
  expect(next.done).toBe(true);
  logs.bookmark(group.segments[1].id, 0, "last bookmark");
  store.db
    .prepare("UPDATE session_logs SET started=? WHERE id=?")
    .run(Date.now() - 31 * 86400000, group.segments[0].id);
  const remaining = logs.group(group.id);
  expect(remaining.expired).toBe(1);
  expect(remaining.segments[0].bookmarks[0].label).toBe("last bookmark");
  expect(logs.readGroup(group.id, first.next).parts[0].text).toBe("last\n");
});

it("rotates for size within a group and retains recent writes when the old active segment expires", () => {
  const { store, logs } = fixture();
  const document = store.read();
  document.settings.logLimitMiB = 10;
  store.save(document);
  logs.prune();
  logs.start("pane", "work");
  logs.append("pane", "x".repeat(2 * 1024 ** 2));
  logs.append("pane", "y".repeat(1024 ** 2));
  const group = logs.groups()[0];
  expect(group.segments.map((s) => s.reason)).toEqual(["start", "rotation"]);
  store.db
    .prepare("UPDATE session_logs SET started=?")
    .run(Date.now() - 31 * 86400000);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 2000);
  logs.append("pane", "new output must survive");
  const current = logs.group(group.id);
  expect(current.expired).toBe(2);
  expect(current.segments).toHaveLength(1);
  expect(logs.read(current.segments[0].id).text).toBe(
    "new output must survive",
  );
});

it("retains expiry metadata for a saved terminal even when all of its files expire", () => {
  const f = fixture();
  f.logs.start("pane", "work");
  f.logs.append("pane", "old");
  f.logs.stop("pane");
  const group = f.logs.groupFor("pane")!;
  f.store.db
    .prepare("INSERT INTO session_resume(id,value) VALUES(?,?)")
    .run("pane", JSON.stringify({ logGroup: group }));
  f.store.db
    .prepare("UPDATE session_logs SET started=?")
    .run(Date.now() - 31 * 86400000);
  const logs = f.reopen();
  expect(logs.groups()).toEqual([]);
  logs.beginConnection("pane", group);
  logs.start("pane", "work");
  expect(logs.groupFor("pane")).toBe(group);
  expect(logs.group(group).expired).toBe(1);
});

it("deletes one segment or a whole group and never resurrects a deleted group", () => {
  const { logs } = fixture();
  logs.start("pane", "work");
  logs.append("pane", "old");
  logs.stop("pane");
  logs.start("pane", "work");
  const group = logs.groups()[0];
  logs.delete(group.segments[0].id);
  expect(logs.group(group.id).removed).toBe(1);
  expect(logs.active.has("pane")).toBe(true);
  logs.deleteGroup(group.id);
  expect(logs.groups()).toEqual([]);
  expect(logs.active.has("pane")).toBe(false);
  logs.beginConnection("pane", group.id);
  logs.start("pane", "work");
  expect(logs.groupFor("pane")).not.toBe(group.id);
});

it("migrates old logs separately without rewriting files or bookmark offsets", () => {
  const f = fixture();
  f.logs.start("one", "same");
  f.logs.append("one", "one\n");
  f.logs.start("two", "same");
  f.logs.append("two", "two\n");
  const rows = f.logs.list();
  f.logs.bookmark(rows[0].id, 1, "legacy");
  f.store.db.exec(
    "DROP TABLE session_log_segments; DROP TABLE session_log_groups; PRAGMA user_version=6;",
  );
  const logs = f.reopen();
  expect(f.store.db.pragma("user_version", { simple: true })).toBe(7);
  expect(logs.groups()).toHaveLength(2);
  expect(logs.list().find((s) => s.id === rows[0].id)?.bookmarks).toEqual([
    { offset: 1, label: "legacy" },
  ]);
  expect(logs.read(rows[0].id).text).toBe("two\n");
  expect(
    fs.readdirSync(f.directory).some((name) => name.startsWith("before-v7-")),
  ).toBe(true);
});
