import { expect, it, vi } from "vitest";
import type { AppEvent } from "../src/shared/model";
import { LocalSessions } from "../src/main/local";
import { Sessions } from "../src/main/ssh";
import type { Store } from "../src/main/store";

for (const kind of ["local", "ssh"] as const) {
  it(`${kind} never cuts a Unicode scalar between output chunks or corrupts UTF-8 logs`, async () => {
    const events: AppEvent[] = [];
    const manager =
      kind === "local"
        ? new LocalSessions((e) => events.push(e))
        : new Sessions(
            {} as Store,
            async () => true,
            (e) => events.push(e),
          );
    const data = "a".repeat(32767) + "💻한글";
    const session = {
      id: "pane",
      generation: "current",
      queue: data,
      inFlight: 0,
      alive: true,
    };
    manager.sessions.set("pane", session as never);
    if (kind === "local") (manager as any).flush("pane");
    else (manager as any).schedule(session);
    await expect
      .poll(() =>
        events
          .filter((e) => e.kind === "output")
          .map((e) => e.data)
          .join(""),
      )
      .toBe(data);
    const bytes = Buffer.concat(
      events.filter((e) => e.kind === "output").map((e) => Buffer.from(e.data)),
    );
    expect(bytes.equals(Buffer.from(data))).toBe(true);
    manager.sessions.clear();
  });
  it(`${kind} ignores acknowledgements and sizes from a replaced connection`, () => {
    const manager =
      kind === "local"
        ? new LocalSessions(() => {})
        : new Sessions(
            {} as Store,
            async () => true,
            () => {},
          );
    const resize = vi.fn(),
      resume = vi.fn();
    const session = {
      generation: "current",
      alive: true,
      status: "connected",
      inFlight: 200000,
      queue: "",
      cols: 80,
      rows: 24,
      pty: { cols: 80, rows: 24, resize, resume },
      behavior: { resized: vi.fn() },
      stream: { setWindow: resize, resume, stderr: { resume } },
    };
    manager.sessions.set("pane", session as never);
    // These callbacks belong to xterm writes/observers from the previous PTY.
    (manager.ack as Function)("pane", 200000, "previous");
    (manager.resize as Function)("pane", 120, 40, "previous");
    expect(session.inFlight).toBe(200000);
    expect(resume).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    (manager.ack as Function)("pane", 200000, "current");
    expect(session.inFlight).toBe(0);
    (manager.resize as Function)("pane", 120, 40, "current");
    expect(resize).toHaveBeenCalledTimes(1);
    manager.sessions.clear();
  });
}
