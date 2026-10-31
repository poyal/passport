import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/renderer/api", () => ({
  api: { call: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../src/renderer/fonts", () => ({
  loadTerminalFont: vi.fn().mockResolvedValue(undefined),
}));
import {
  terminals,
  restoreTerminal,
  hydrateTerminals,
} from "../src/renderer/terminals";

afterEach(() => terminals.clear());
function fixture() {
  const callbacks: (() => void)[] = [];
  const term = {
    cols: 80,
    rows: 24,
    unicode: { activeVersion: "11" },
    reset: vi.fn(),
    refresh: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      term.cols = cols;
      term.rows = rows;
    }),
    write: vi.fn((data: string, callback: () => void) => {
      if (!data) callback();
      else callbacks.push(callback);
    }),
  };
  const entry = {
    term,
    connected: false,
    connectionRevision: 1,
    sessionInstanceId: "old",
    unicodeWidth: "unicode11",
    hydrating: false,
    checkpointReady: true,
    element: { clientWidth: 0, clientHeight: 0 },
    fit: { fit: vi.fn() },
  };
  terminals.set("pane", entry as never);
  const screen = {
    id: "pane",
    data: "saved 한글",
    cols: 60,
    rows: 20,
    unicodeWidth: "unicode11" as const,
  };
  return { entry, term, callbacks, screen };
}
it("a late restore cannot resize or checkpoint a newer connection", async () => {
  const { entry, term, callbacks, screen } = fixture();
  const restoring = restoreTerminal(screen, () => false);
  await Promise.resolve();
  entry.connectionRevision++;
  entry.sessionInstanceId = "new";
  entry.connected = true;
  term.resize(132, 42);
  callbacks.shift()!();
  await restoring;
  expect([term.cols, term.rows]).toEqual([132, 42]);
  expect(entry.checkpointReady).toBe(false);
  expect(entry.connected).toBe(true);
});
it("cancellation during parsing does not mark an old screen ready for persistence", async () => {
  const { entry, callbacks, screen } = fixture();
  let cancelled = false;
  const restoring = restoreTerminal(screen, () => cancelled);
  await Promise.resolve();
  cancelled = true;
  callbacks.shift()!();
  await restoring;
  expect(entry.checkpointReady).toBe(false);
  expect(entry.hydrating).toBe(false);
});
it("an earlier window snapshot callback cannot finish a later hydration", () => {
  const { entry, callbacks, screen } = fixture();
  hydrateTerminals([{ ...screen, sessionInstanceId: "first" }]);
  hydrateTerminals([{ ...screen, sessionInstanceId: "second" }]);
  callbacks.shift()!();
  expect(entry.hydrating).toBe(true);
  expect(entry.checkpointReady).toBe(false);
  callbacks.shift()!();
  expect(entry.hydrating).toBe(false);
  expect(entry.checkpointReady).toBe(true);
});
