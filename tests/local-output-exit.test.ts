import { expect, it, vi } from "vitest";
import os from "node:os";
const driver = vi.hoisted(() => ({
  data: (_text: string) => {},
  exit: () => {},
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    cols: 100,
    rows: 30,
    pause() {},
    resume() {},
    kill() {},
    resize() {},
    passportWrite(_data: Buffer, done: () => void) {
      done();
    },
    onData(callback: (text: string) => void) {
      driver.data = callback;
      return { dispose() {} };
    },
    onExit(callback: () => void) {
      driver.exit = callback;
      return { dispose() {} };
    },
  })),
}));
import { LocalSessions } from "../src/main/local";

it.each([false, true])(
  "flushes the final Unicode output before disconnect stops recording (backpressure=%s)",
  async (blocked) => {
    let recording = true;
    const logged: Buffer[] = [];
    const local = new LocalSessions((event) => {
      if (event.kind === "output" && recording)
        logged.push(Buffer.from(event.data));
      if (event.kind === "session" && event.state.status === "disconnected")
        recording = false;
    });
    try {
      local.open("pane", { shell: "default", cwd: os.tmpdir() });
      if (blocked) local.sessions.get("pane")!.inFlight = 262144;
      const final = "a".repeat(32767) + "💻한글 LAST_LINE\r\n";
      driver.data(final);
      // A short-lived CLI can exit before the 8 ms output batching timer fires.
      driver.exit();
      await local.shutdown();
      expect(Buffer.concat(logged).equals(Buffer.from(final))).toBe(true);
      expect(recording).toBe(false);
    } finally {
      await local.shutdown();
    }
  },
);
