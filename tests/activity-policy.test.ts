import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityService, OscNotifications } from "../src/main/activity";
import { Store } from "../src/main/store";
import type { Activity } from "../src/shared/model";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of dispose.splice(0)) await close();
});
function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "passport-policy-"));
  const store = new Store(folder, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  const notifications: Activity[] = [];
  let includeResponse = false;
  const service = new ActivityService(store.db, {
    workspace: () => "workspace",
    changed: () => {},
    notify: (item) => notifications.push(item),
    ready: () => {},
    error: () => {},
    includeResponse: () => includeResponse,
  });
  dispose.push(async () => {
    await service.close();
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const generation = randomUUID(),
    auth = service.register("pane", generation, { claude: true, codex: true });
  const send = (event: string, rest: Record<string, unknown> = {}) =>
    service.receive({
      generation,
      token: auth.PASSPORT_TOKEN,
      source: "claude",
      run: "run",
      session: "s",
      event,
      ...rest,
    });
  send("run-start");
  return {
    service,
    store,
    notifications,
    send,
    optIn: (value: boolean) => {
      includeResponse = value;
    },
  };
}
it("ignores split progress control strings while retaining real OSC notifications", () => {
  const receive = vi.fn(),
    parser = new OscNotifications(receive);
  for (const part of [
    "\x1b]9;",
    "4;3;0\x07",
    "\x1b]9;4;0\x1b\\",
    "\x1b]9;Approval requested\x07",
    "\x1b]777;notify;title;body\x07",
  ])
    parser.push(part);
  expect(receive.mock.calls).toEqual([
    ["9;Approval requested"],
    ["777;notify;title;body"],
  ]);
});
it("notifies confirmed approvals once and never resolves another request by reading or unrelated work", () => {
  const { send, service, notifications } = fixture();
  send("permission-candidate", { request: "r" });
  expect(notifications).toHaveLength(0);
  send("permission", { request: "r" });
  send("permission", { request: "r" });
  service.readPane("pane");
  send("tool-done", { request: "other" });
  expect(notifications).toHaveLength(1);
  expect(service.list()[0]).toMatchObject({
    kind: "permission",
    read: true,
    resolved: false,
  });
  send("tool-done", { request: "r" });
  expect(service.list()[0].resolved).toBe(true);
  send("permission", { request: "r2" });
  expect(notifications).toHaveLength(2);
});
it("coalesces automated questions, tracks real questions, and cancels timers on revocation", async () => {
  vi.useFakeTimers();
  const { send, service, notifications } = fixture();
  send("input-candidate", { request: "auto" });
  send("tool-done", { request: "auto" });
  await vi.advanceTimersByTimeAsync(500);
  expect(notifications).toHaveLength(0);
  send("input-candidate", { request: "question" });
  send("input-candidate", { request: "question" });
  await vi.advanceTimersByTimeAsync(500);
  expect(service.list()[0]).toMatchObject({ kind: "input", resolved: false });
  send("input-required", { request: "question" });
  expect(notifications).toHaveLength(1);
  send("input-resolved", { request: "question" });
  expect(service.list()[0].resolved).toBe(true);
  send("input-candidate", { request: "revoked" });
  service.restrictAgents({ claude: false, codex: true });
  await vi.advanceTimersByTimeAsync(500);
  expect(notifications).toHaveLength(1);
});
it("keeps consecutive turns and sessions separate without repeating one completion", () => {
  const { send, notifications } = fixture();
  send("turn-start");
  send("stop-candidate");
  send("stop-candidate");
  send("turn-start");
  send("stop-candidate");
  send("stop-candidate", { session: "other" });
  expect(notifications).toHaveLength(3);
  send("tool-start", { request: "continued-by-hook" });
  send("stop-candidate");
  expect(notifications).toHaveLength(4);
});
it("never persists excerpts without opt-in and bounds sanitized excerpts after opt-in", () => {
  const { send, store, optIn, service } = fixture();
  send("completed", { turn: "one", summary: "PRIVATE_BEFORE" });
  expect(
    JSON.stringify(store.db.prepare("SELECT value FROM activity").all()),
  ).not.toContain("PRIVATE_BEFORE");
  optIn(true);
  send("completed", {
    turn: "two",
    summary: "\x1b private\n" + "한".repeat(240),
  });
  expect(Array.from(service.list()[0].body)).toHaveLength(200);
  expect(service.list()[0].body).not.toMatch(/[\x00-\x1f]/);
  optIn(false);
  send("completed", { turn: "three", summary: "PRIVATE_AFTER" });
  expect(
    JSON.stringify(store.db.prepare("SELECT value FROM activity").all()),
  ).not.toContain("PRIVATE_AFTER");
});
it("alerts on stopped turns, not ordinary tool failures or successful process exit", () => {
  const { send, notifications, service } = fixture();
  send("tool-done", { request: "failed-tool" });
  expect(notifications).toHaveLength(0);
  send("turn-failed");
  expect(service.list()[0]).toMatchObject({ kind: "failed", resolved: false });
  send("run-end", { exitCode: 1 });
  expect(notifications).toHaveLength(1);
});
it("clears a terminated run's failure on relaunch while preserving live requests", () => {
  const { send, service } = fixture();
  send("run-start", { run: "parallel" });
  send("permission", { run: "parallel", request: "approval" });
  send("run-end", { exitCode: 7 });
  expect(service.list()[0]).toMatchObject({ kind: "failed", resolved: false });
  send("run-start", { run: "retry" });
  expect(service.list().find((row) => row.kind === "failed")?.resolved).toBe(
    true,
  );
  expect(
    service.list().find((row) => row.kind === "permission")?.resolved,
  ).toBe(false);
});
