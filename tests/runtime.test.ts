import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { SessionLogs } from "../src/main/logs";
import { LocalSessions, availableShells } from "../src/main/local";
import type { AppEvent } from "../src/shared/model";

it("records only opted-in output, searches across chunks, persists bookmarks, exports, and enforces retention", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-logs-"));
  const store = new Store(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw Error();
    },
    decryptString: () => {
      throw Error();
    },
  });
  try {
    const logs = new SessionLogs(store);
    logs.append("a", "not recorded");
    expect(logs.list()).toHaveLength(0);
    logs.start("a", "시험");
    const text = "x".repeat(262140) + "SEARCH_BOUNDARY 한글\n";
    logs.append("a", text);
    logs.stop("a");
    logs.append("a", "not recorded");
    const log = logs.list()[0];
    expect(log.bytes).toBe(Buffer.byteLength(text));
    expect(log.recording).toBe(false);
    const read = logs.read(log.id, 0, "SEARCH_BOUNDARY");
    expect(read.matches).toEqual([262140]);
    expect(logs.read(log.id, 0, "not present").next).toBe(log.bytes);
    logs.bookmark(log.id, 262140, "검색 결과");
    expect(logs.list()[0].bookmarks[0]).toEqual({
      offset: 262140,
      label: "검색 결과",
    });
    const destination = path.join(dir, "export.txt");
    logs.export(log.id, destination);
    expect(await fs.readFile(destination, "utf8")).toBe(text);
    logs.remember("printf safe");
    expect(logs.history("safe")).toEqual(["printf safe"]);
    store.db
      .prepare("UPDATE session_logs SET started=? WHERE id=?")
      .run(Date.now() - 31 * 86400000, log.id);
    expect(logs.list()).toHaveLength(0);
    logs.start("b", "large");
    logs.append("b", "x");
    store.db.prepare("UPDATE session_logs SET bytes=?").run(1025 * 1024 ** 2);
    expect(logs.list()).toHaveLength(1);
    expect(logs.active.size).toBe(1);
    logs.append("b", "after rotation");
    expect(logs.read(logs.list()[0].id).text).toBe("after rotation");
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("ignores stale exit callbacks after reopening a local pane and drains closed PTYs before shutdown", async () => {
  const events: AppEvent[] = [];
  const local = new LocalSessions((event) => {
    events.push(event);
    if (event.kind === "output") local.ack(event.id, event.bytes);
  });
  try {
    for (let n = 0; n < 4; n++) {
      local.open("same", { shell: "default", cwd: os.tmpdir() });
      local.close("same");
    }
    local.open("same", { shell: "default", cwd: os.tmpdir() });
    events.length = 0;
    local.input(
      "same",
      process.platform === "win32"
        ? "echo REOPEN_READY\r"
        : "printf 'REOPEN_%s\\n' READY\r",
    );
    await expect
      .poll(
        () =>
          events
            .filter((e) => e.kind === "output")
            .map((e) => e.data)
            .join(""),
        { timeout: 5000 },
      )
      .toContain("REOPEN_READY");
    expect(
      events.filter(
        (e) => e.kind === "session" && e.state.status === "disconnected",
      ),
    ).toHaveLength(0);
    local.close("same");
    await local.shutdown();
    expect(local.sessions.size).toBe(0);
    expect(() => local.open("late", { shell: "default", cwd: "" })).toThrow(
      "앱을 종료",
    );
  } finally {
    await local.shutdown();
  }
});

it.skipIf(process.platform === "win32")(
  "waits for a shell that ignores SIGHUP and force-closes it before shutdown",
  async () => {
    let output = "";
    const local = new LocalSessions((e) => {
      if (e.kind === "output") {
        output += e.data;
        local.ack(e.id, e.bytes);
      }
    });
    try {
      local.open("stubborn", { shell: "bash", cwd: os.tmpdir() });
      const pid = local.sessions.get("stubborn")!.pty.pid;
      local.input("stubborn", "trap '' HUP; printf 'IGNORE_%s\\n' HUP_READY\r");
      await expect
        .poll(() => output, { timeout: 5000 })
        .toContain("IGNORE_HUP_READY");
      await local.shutdown();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await local.shutdown();
    }
  },
);

it("runs a native local PTY, accepts input and resize, and closes its process", async () => {
  expect(availableShells().length).toBeGreaterThan(0);
  const output: string[] = [];
  const local = new LocalSessions((e) => {
    if (e.kind === "output") {
      output.push(e.data);
      local.ack(e.id, e.bytes);
    }
  });
  try {
    local.open("local", { shell: "default", cwd: os.tmpdir() });
    local.resize("local", 91, 37);
    local.input(
      "local",
      process.platform === "win32"
        ? "echo PASSPORT_PTY_OK\r"
        : "stty size; printf 'PASSPORT_%s\\n' 'PTY_OK'\r",
    );
    for (
      let n = 0;
      n < 100 && !output.join("").includes("PASSPORT_PTY_OK");
      n++
    )
      await new Promise((r) => setTimeout(r, 50));
    expect(output.join("")).toContain("PASSPORT_PTY_OK");
    if (process.platform !== "win32")
      expect(output.join("")).toContain("37 91");
    local.close("local");
    expect(local.sessions.size).toBe(0);
  } finally {
    await local.shutdown();
  }
});

it("keeps recording after retention rotation, bounds disk usage, and reports write failures", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-log-rotation-"),
  );
  const store = new Store(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  try {
    const settings = store.read();
    settings.settings.logLimitMiB = 10;
    store.save(settings);
    const errors: string[] = [],
      logs = new SessionLogs(store, (error) => errors.push(error));
    logs.start("live", "still connected");
    logs.append("live", "old output");
    store.db
      .prepare("UPDATE session_logs SET started=?")
      .run(Date.now() - 31 * 86400000);
    logs.prune();
    logs.append("live", "new output");
    expect(logs.list()).toHaveLength(1);
    expect(logs.read(logs.list()[0].id).text).toBe("new output");
    for (let i = 0; i < 12; i++) logs.append("live", "x".repeat(1024 ** 2));
    const rows = logs.list();
    expect(rows.reduce((n, row) => n + row.bytes, 0)).toBeLessThanOrEqual(
      10 * 1024 ** 2,
    );
    expect(rows.some((row) => row.recording)).toBe(true);
    await fs.rm(logs.folder, { recursive: true });
    logs.append("live", "cannot write");
    logs.append("live", "already stopped");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("기록이 중단");
    expect(logs.active.has("live")).toBe(false);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
