import { afterEach, expect, it, vi } from "vitest";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  TerminalControl,
  ControlInspector,
} from "../src/main/terminal-control";
import { platform, selectPlatform } from "../src/main/platform";
import { localTerminalEnv } from "../src/main/terminal-env";
import { terminalSettingsSchema } from "../src/shared/terminal-config";
import {
  controlPaste,
  readControlText,
  controlRequestSchema,
  type ControlPanel,
  type ControlRequest,
  type ControlCommand,
  type ControlInspection,
} from "../src/shared/terminal-control";

const services: TerminalControl[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
const panel = (name: string): ControlPanel => ({
  paneId: randomUUID(),
  workspaceId: randomUUID(),
  workspaceName: name,
  windowId: 1,
  sessionId: randomUUID(),
  status: "connected",
  shell: "bash",
  launchCwd: "/start",
  configuredAgent: null,
  moving: false,
});
async function fixture(mode: "read" | "write" = "write") {
  const source = panel("caller"),
    target = panel("target");
  target.windowId = 2;
  const panels = [source, target];
  const write = vi.fn();
  const inspect = vi.fn(
    async (p: ControlPanel): Promise<ControlInspection> => ({
      requestId: randomUUID(),
      paneId: p.paneId,
      sessionId: p.sessionId,
      bracketedPaste: true,
      backspace: "DEL",
      text: "한글 결과",
      buffer: "normal",
      truncated: false,
    }),
  );
  const endpoint = platform.createControlEndpoint();
  const service = new TerminalControl({
    endpoint,
    panels: () => panels,
    inspect,
    write,
  });
  services.push(service);
  await service.start();
  service.configure(mode);
  const env = service.register(source.paneId, source.sessionId!);
  const request = (command: ControlCommand): ControlRequest => ({
    version: 1,
    token: env.PASSPORT_CONTROL_TOKEN,
    source: { paneId: source.paneId, sessionId: source.sessionId! },
    request: command,
  });
  return {
    service,
    source,
    target,
    panels,
    write,
    inspect,
    env,
    request,
    endpoint,
  };
}
it("defaults old documents to off and clears inherited CLI credentials case insensitively", () => {
  expect(terminalSettingsSchema.parse({}).cliAccess).toBe("off");
  const env = localTerminalEnv({
    passport_control_token: "secret",
    PASSPORT_CONTROL_ENDPOINT: "old",
    PASSPORT_PANE_ID: "old",
    PASSPORT_SESSION_ID: "old",
    CUSTOM: "keep",
  });
  expect(env.CUSTOM).toBe("keep");
  expect(
    Object.keys(env).some((key) =>
      /passport_(control|pane|session)/i.test(key),
    ),
  ).toBe(false);
  expect(controlRequestSchema.safeParse({ version: 2 }).success).toBe(false);
  for (const id of ["darwin", "win32"])
    expect(typeof selectPlatform(id).createControlEndpoint).toBe("function");
});
it("grants sharing independently of terminal control and revokes the session capability when disabled", async () => {
  const source = panel("share caller");
  let enabled = true;
  const execute = vi.fn(() => [{ name: "승민" }]);
  const service = new TerminalControl({
    endpoint: platform.createControlEndpoint(),
    panels: () => [source],
    inspect: vi.fn(),
    write: vi.fn(),
    share: { enabled: () => enabled, execute },
  });
  services.push(service);
  await service.start();
  service.configure("off");
  const env = service.register(source.paneId, source.sessionId!);
  const request = (command: ControlCommand): ControlRequest => ({
    version: 1,
    token: env.PASSPORT_CONTROL_TOKEN,
    source: { paneId: source.paneId, sessionId: source.sessionId! },
    request: command,
  });
  await expect(
    service.execute(request({ command: "share.peers" })),
  ).resolves.toEqual([{ name: "승민" }]);
  await expect(service.execute(request({ command: "list" }))).rejects.toThrow(
    /터미널 제어/,
  );
  await expect(
    service.execute(
      request({ command: "read", pane: source.paneId, lines: 10 }),
    ),
  ).rejects.toThrow(/터미널 제어/);
  enabled = false;
  service.configure("off");
  await expect(
    service.execute(request({ command: "share.peers" })),
  ).rejects.toThrow(/권한/);
  enabled = true;
  service.configure("off");
  await expect(
    service.execute(request({ command: "share.peers" })),
  ).rejects.toThrow(/권한/);
  expect(execute).toHaveBeenCalledTimes(1);
});
it("revokes a waiting share approval when the calling pane reconnects", async () => {
  const source = panel("approval caller");
  let release!: () => void,
    approved = false;
  const service = new TerminalControl({
    endpoint: platform.createControlEndpoint(),
    panels: () => [source],
    inspect: vi.fn(),
    write: vi.fn(),
    share: {
      enabled: () => true,
      execute: async (_input, authorize) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        authorize();
        approved = true;
      },
    },
  });
  services.push(service);
  await service.start();
  service.configure("off");
  const env = service.register(source.paneId, source.sessionId!);
  const pending = service.execute({
    version: 1,
    token: env.PASSPORT_CONTROL_TOKEN,
    source: { paneId: source.paneId, sessionId: source.sessionId! },
    request: { command: "share.approve", id: randomUUID() },
  });
  source.sessionId = randomUUID();
  service.register(source.paneId, source.sessionId);
  release();
  await expect(pending).rejects.toThrow(/권한|만료/);
  expect(approved).toBe(false);
});

it("preserves Korean, templates, tabs and trailing newlines without adding Enter", () => {
  expect(controlPaste("한글 {{literal}}\r\n둘\t끝\n", true, false)).toBe(
    "\x1b[200~한글 {{literal}}\r둘\t끝\r\x1b[201~",
  );
  expect(controlPaste("문장", false, false)).toBe("문장");
  expect(controlPaste("문장", true, true)).toBe("\x1b[200~문장\x1b[201~\r");
  for (const text of ["끝\n", "둘\t끝", "첫\r둘"])
    expect(() => controlPaste(text, false, false)).toThrow("지원하지");
  for (const text of ["\x1b[201~", "\0", "\x03", "\x85"])
    expect(() => controlPaste(text, true, false)).toThrow("제어 문자");
  expect(() => controlPaste("한".repeat(100000), true, false)).toThrow(
    "256 KiB",
  );
});
it("reads logical wrapped lines and omits unused rows without emitting escape controls", () => {
  const rows = [
    [false, "old  "],
    [false, "가 나 "],
    [true, "다  "],
    [false, "last\x1b  "],
    [false, "    "],
  ] as const;
  const buffer = {
    length: rows.length,
    getLine: (i: number) => ({
      isWrapped: rows[i][0],
      translateToString: (trim?: boolean) =>
        trim ? rows[i][1].trimEnd() : rows[i][1],
    }),
  };
  expect(readControlText(buffer, 2)).toEqual({
    text: "가 나 다\nlast",
    truncated: true,
  });
  expect(readControlText(buffer, 100)).toEqual({
    text: "old\n가 나 다\nlast",
    truncated: false,
  });
});
it("identifies the caller and reads a disconnected target in another window", async () => {
  const f = await fixture("read");
  expect(
    await f.service.execute(f.request({ command: "identify" })),
  ).toMatchObject({ paneId: f.source.paneId });
  f.target.status = "disconnected";
  expect(
    await f.service.execute(
      f.request({ command: "read", pane: f.target.paneId, lines: 20 }),
    ),
  ).toMatchObject({ text: "한글 결과", sessionId: f.target.sessionId });
  await expect(
    f.service.execute(
      f.request({ command: "key", pane: f.target.paneId, key: "enter" }),
    ),
  ).rejects.toMatchObject({ code: "READ_ONLY" });
  expect(f.write).not.toHaveBeenCalled();
});
it("rejects missing, ambiguous and moving targets before writing", async () => {
  const f = await fixture();
  f.panels.push({ ...panel("target"), workspaceId: f.target.workspaceId });
  await expect(
    f.service.execute(
      f.request({ command: "key", tab: "target", key: "enter" }),
    ),
  ).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET" });
  await expect(
    f.service.execute(
      f.request({ command: "key", pane: randomUUID(), key: "enter" }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  f.target.moving = true;
  await expect(
    f.service.execute(
      f.request({ command: "key", pane: f.target.paneId, key: "enter" }),
    ),
  ).rejects.toMatchObject({ code: "MOVING" });
  expect(f.write).not.toHaveBeenCalled();
});
it("rejects stale credentials and revokes them even when access is re-enabled", async () => {
  const f = await fixture();
  const r = f.request({ command: "list" });
  await expect(
    f.service.execute({ ...r, token: "f".repeat(64) }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  f.service.configure("off");
  f.service.configure("write");
  await expect(f.service.execute(r)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(
    f.service.register(f.source.paneId, f.source.sessionId!)
      .PASSPORT_CONTROL_TOKEN,
  ).not.toBe(r.token);
  f.service.unregister(f.source.paneId);
  await expect(f.service.execute(r)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
it.each(["generation", "owner", "permission", "caller", "deadline"])(
  "rechecks %s after awaiting the renderer",
  async (change) => {
    const f = await fixture();
    f.inspect.mockImplementationOnce(async (p) => {
      const old = p.sessionId;
      if (change === "generation") f.target.sessionId = randomUUID();
      if (change === "owner") f.target.windowId++;
      if (change === "permission") f.service.configure("off");
      if (change === "caller") f.source.status = "disconnected";
      if (change === "deadline") abort.abort();
      return {
        requestId: randomUUID(),
        paneId: p.paneId,
        sessionId: old,
        bracketedPaste: true,
      };
    });
    const abort = new AbortController();
    await expect(
      f.service.execute(
        f.request({
          command: "send",
          pane: f.target.paneId,
          text: "safe",
          submit: true,
        }),
        abort.signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.write).not.toHaveBeenCalled();
  },
);
it("serializes concurrent input and keeps submit in the same PTY write", async () => {
  const f = await fixture();
  await Promise.all([
    f.service.execute(
      f.request({
        command: "send",
        pane: f.target.paneId,
        text: "one\n",
        submit: true,
      }),
    ),
    f.service.execute(
      f.request({ command: "key", pane: f.target.paneId, key: "ctrl-c" }),
    ),
  ]);
  expect(f.write.mock.calls).toEqual([
    [f.target.paneId, "\x1b[200~one\r\x1b[201~\r"],
    [f.target.paneId, "\x03"],
  ]);
});
it("accepts only a matching renderer owner, pane and generation", async () => {
  let sent: any;
  const inspector = new ControlInspector((_owner, request) => {
    sent = request;
  });
  const target = panel("target");
  const abort = new AbortController();
  const result = inspector.inspect(target, 20, abort.signal);
  inspector.reply(target.windowId + 1, { ...sent, text: "wrong" });
  inspector.reply(target.windowId, {
    ...sent,
    paneId: randomUUID(),
    text: "wrong",
  });
  inspector.reply(target.windowId, { ...sent, text: "correct" });
  expect(await result).toMatchObject({ text: "correct" });
  const cancelled = inspector.inspect(target, 20, abort.signal);
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
});
it("handles fragmented local socket requests and returns explicit malformed-request errors", async () => {
  const f = await fixture();
  const exchange = (data: string) =>
    new Promise<any>((resolve, reject) => {
      const socket = net.connect(f.endpoint.address);
      let response = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (data) => {
        response += data;
      });
      socket.on("end", () => resolve(JSON.parse(response)));
      socket.on("connect", () => {
        socket.write(data.slice(0, 7));
        socket.write(data.slice(7) + "\n");
      });
    });
  expect(
    await exchange(JSON.stringify(f.request({ command: "list" }))),
  ).toMatchObject({ version: 1, ok: true });
  expect(await exchange('{"version":2}')).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST" },
  });
});
it("runs the bundled native CLI against the real local transport", async () => {
  const f = await fixture();
  const cli = path.resolve(
    `resources/terminal/helper/${process.platform}-${process.arch}/${process.platform === "win32" ? "passport.exe" : "passport"}`,
  );
  const run = (args: string[], credentials = f.env) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(
        cli,
        args,
        {
          env: { ...localTerminalEnv(), ...credentials },
          windowsHide: true,
          timeout: 8000,
          encoding: "utf8",
        },
        (error, stdout) => {
          resolve({ code: error ? Number(error.code) || 1 : 0, stdout });
        },
      );
    });
  expect((await run(["--help"], {})).stdout).toContain("passport identify");
  const identified = await run(["identify", "--json"]);
  expect(identified.code).toBe(0);
  expect(JSON.parse(identified.stdout)).toMatchObject({
    ok: true,
    value: { paneId: f.source.paneId },
  });
  const sent = await run([
    "send",
    "--pane",
    f.target.paneId,
    "--json",
    "한글\n끝\n",
    "--submit",
  ]);
  expect(sent.code).toBe(0);
  expect(f.write).toHaveBeenLastCalledWith(
    f.target.paneId,
    "\x1b[200~한글\r끝\r\x1b[201~\r",
  );
  expect((await run(["read", "--lines", "0", "--json"])).code).toBe(2);
  expect((await run(["identify", "--json"], {})).code).toBe(1);
});
