import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as pty from "node-pty";
import { TerminalInputQueue, ptyInputWriter } from "../src/main/terminal-input";
import {
  InputBudget,
  inputChunkLimit,
  pasteTextLimit,
  pasteStart,
  pasteEnd,
  prepareTerminalPaste,
  type InputStatus,
} from "../src/shared/terminal-input";
import { PasteQueue } from "../src/shared/paste";
import { prepareTerminalClipboard } from "../src/main/terminal-clipboard";
import { localTerminalEnv } from "../src/main/terminal-env";
import fs from "node:fs";
import vm from "node:vm";

const queues: TerminalInputQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((queue) => queue.dispose());
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
function fixture(limits = new InputBudget(), id = "pane", held = false) {
  const chunks: Buffer[] = [],
    events: InputStatus[] = [];
  const callbacks: ((error?: Error) => void)[] = [];
  const fail = vi.fn();
  const queue = new TerminalInputQueue(
    id,
    (data, done) => {
      chunks.push(Buffer.from(data));
      if (held) callbacks.push(done);
      else done();
    },
    (event) => events.push(event),
    fail,
    undefined,
    limits,
  );
  queues.push(queue);
  return { queue, chunks, events, callbacks, fail, limits };
}

it("accepts a 4 MiB body independently of framing and rejects oversize before any write", async () => {
  const f = fixture();
  for (const size of [262132, 262144, 1024 * 1024, pasteTextLimit]) {
    const text = "a".repeat(size);
    f.queue.paste(text, true, "generation");
    await expect.poll(() => f.queue.busy).toBe(false);
    const sent = Buffer.concat(f.chunks.splice(0));
    expect(hash(sent)).toBe(hash(pasteStart + text + pasteEnd));
  }
  for (const text of [
    "a".repeat(pasteTextLimit + 1),
    "한".repeat(Math.ceil(pasteTextLimit / 3)),
  ])
    expect(() => f.queue.paste(text, true, "generation")).toThrow("4 MiB");
  expect(f.chunks).toHaveLength(0);
  expect(f.limits.bytes).toBe(0);
});

it("normalizes once and preserves Unicode, one paste frame and following input order", async () => {
  const f = fixture();
  const text = "한글💻e\u0301\r\n다음\n".repeat(5000);
  f.queue.paste(text, true, "generation");
  f.queue.input("AFTER\r");
  f.queue.paste("last\n", false, "generation");
  await expect.poll(() => f.queue.busy).toBe(false);
  expect(Buffer.concat(f.chunks).toString()).toBe(
    pasteStart + prepareTerminalPaste(text) + pasteEnd + "AFTER\rlast",
  );
  for (const chunk of f.chunks) {
    expect(chunk.length).toBeLessThanOrEqual(inputChunkLimit);
    expect(Buffer.from(chunk.toString())).toEqual(chunk);
  }
  expect(() => prepareTerminalPaste("hello\x1b[201~\nexec")).toThrow(
    "제어 문자",
  );
});

it("waits for transport completion, bounds every panel and the process, and releases reservations", async () => {
  const limits = new InputBudget();
  const fixtures = Array.from({ length: 4 }, (_, n) =>
    fixture(limits, `pane-${n}`, true),
  );
  for (const f of fixtures) {
    f.queue.paste("a".repeat(pasteTextLimit), true, "old");
    f.queue.paste("b".repeat(pasteTextLimit), true, "old");
  }
  await turn();
  expect(limits.bytes).toBe(32 * 1024 * 1024);
  for (const f of fixtures) {
    expect(f.chunks).toHaveLength(1);
    expect(() => f.queue.input("x")).toThrow("대기 용량");
  }
  const extra = fixture(limits, "extra", true);
  expect(() => extra.queue.input("x")).toThrow("대기 용량");
  fixtures.forEach((f) => f.queue.dispose());
  fixtures.forEach((f) => f.callbacks.shift()!());
  await turn();
  expect(limits.bytes).toBe(0);
  expect(limits.requests).toBe(0);
  fixtures.forEach((f) => expect(f.chunks).toHaveLength(1));
  extra.queue.input("new");
  await turn();
  expect(extra.chunks[0].toString()).toBe("new");
});

it.each([inputChunkLimit - 10, inputChunkLimit * 3])(
  "Ctrl+C cancels remaining input and closes a partially sent paste (%i)",
  async (size) => {
    const f = fixture(undefined, "pane", true);
    f.queue.paste("x".repeat(size), true, "old");
    f.queue.input("MUST_NOT_SEND");
    await turn();
    expect(f.chunks).toHaveLength(1);
    f.queue.input("\x03");
    for (let n = 0; n < 8 && f.queue.busy; n++) {
      f.callbacks.shift()?.();
      await turn();
    }
    expect(f.queue.busy).toBe(false);
    const sent = Buffer.concat(f.chunks).toString();
    expect(sent.startsWith(pasteStart)).toBe(true);
    expect(sent.endsWith(pasteEnd + "\x03")).toBe(true);
    expect(sent.split(pasteEnd)).toHaveLength(2);
    expect(sent).not.toContain("MUST_NOT_SEND");
    expect(f.events.at(-1)?.status).toBe("cancelled");
    expect(f.limits.bytes).toBe(0);
  },
);

it("does not retry a partial failed write or send queued commands", async () => {
  const f = fixture(undefined, "pane", true);
  f.queue.paste("x".repeat(100000), true, "old");
  f.queue.input("MUST_NOT_SEND");
  await turn();
  f.callbacks.shift()!(new Error("broken transport"));
  await turn();
  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.events.at(-1)).toMatchObject({
    status: "failed",
    message: "broken transport",
  });
  expect(f.chunks).toHaveLength(1);
  expect(f.limits.requests).toBe(0);
});

it("cancels a CLI-style bracketed write without leaving paste mode or submitting its trailing Enter", async () => {
  const f = fixture(undefined, "pane", true);
  f.queue.input(pasteStart + "a".repeat(100000) + pasteEnd + "\r");
  await turn();
  f.queue.input("\x03");
  for (let n = 0; n < 8 && f.queue.busy; n++) {
    f.callbacks.shift()?.();
    await turn();
  }
  const sent = Buffer.concat(f.chunks).toString();
  expect(sent.endsWith(pasteEnd + "\x03")).toBe(true);
  expect(sent).not.toContain("\r");
  expect(f.limits.requests).toBe(0);
});

it("limits tiny input requests as well as payload bytes", () => {
  const limits = new InputBudget();
  const releases = Array.from({ length: 1024 }, () => limits.reserve("one", 0));
  expect(() => limits.reserve("one", 0)).toThrow("대기 용량");
  for (let n = 0; n < 3072; n++) releases.push(limits.reserve(`pane-${n}`, 0));
  expect(() => limits.reserve("extra", 0)).toThrow("대기 용량");
  releases.forEach((release) => {
    release();
    release();
  });
  expect(limits.requests).toBe(0);
});

it("reserves clipboard capacity before reads, preserves gestures and cancels stale reads", async () => {
  const limits = new InputBudget();
  const queue = new PasteQueue(limits, "pane");
  const read = vi.fn(async () => "value"),
    fail = vi.fn(),
    delivered = vi.fn();
  const first = queue.enqueue(read, () => true, delivered, fail);
  const second = queue.enqueue(read, () => true, delivered, fail);
  await queue.enqueue(read, () => true, delivered, fail);
  queue.cancel();
  await Promise.all([first, second]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(delivered).not.toHaveBeenCalled();
  expect(limits.bytes).toBe(0);
});

it("checks aggregate clipboard bytes, including separators and multi-byte text", async () => {
  const options = (texts: string[]) => ({
    read: async () =>
      texts.map((text) => ({
        types: ["text/plain"],
        getType: async () => new Blob([text]),
      })),
    toPNG: () => Buffer.alloc(0),
    userData: "",
    platform: "darwin",
    shell: "zsh" as const,
    check() {},
  });
  const text = "한".repeat(Math.floor(pasteTextLimit / 3)) + "a";
  expect((await prepareTerminalClipboard(options([text]))).kind).toBe("text");
  await expect(
    prepareTerminalClipboard(options([text, "a"])),
  ).rejects.toThrow();
  await expect(
    prepareTerminalClipboard(
      options(["한".repeat(800000), "한".repeat(800000)]),
    ),
  ).rejects.toThrow();
});

it("PTY completion handles partial writes, EAGAIN, errors and late callbacks after disposal", () => {
  const source = fs.readFileSync(
    "node_modules/node-pty/lib/unixTerminal.js",
    "utf8",
  );
  const callbacks: ((error: unknown, written?: number) => void)[] = [];
  const scheduled: (() => void)[] = [];
  const context: any = {
    Buffer,
    fs: { write: vi.fn((...args: any[]) => callbacks.push(args.at(-1))) },
    setImmediate: (fn: () => void) => scheduled.push(fn),
    clearImmediate() {},
  };
  vm.runInNewContext(
    source.slice(source.indexOf("var CustomWriteStream =")) +
      "\nglobalThis.Stream = CustomWriteStream;",
    context,
  );
  const stream = new context.Stream(123, "utf8");
  const done = vi.fn();
  stream.write(Buffer.from("abcd"), done);
  callbacks.shift()!(null, 2);
  expect(done).not.toHaveBeenCalled();
  callbacks.shift()!({ code: "EAGAIN" });
  scheduled.shift()!();
  callbacks.shift()!(null, 2);
  expect(done).toHaveBeenCalledTimes(1);
  const closed = vi.fn();
  stream.write("unfinished", closed);
  stream.dispose();
  expect(closed).toHaveBeenCalledTimes(1);
  callbacks.shift()!(null, 1);
  expect(closed).toHaveBeenCalledTimes(1);
  const broken = new context.Stream(124, "utf8"),
    failed = vi.fn();
  broken.write("data", failed);
  const error = new Error("EIO");
  callbacks.shift()!(error);
  expect(failed).toHaveBeenCalledWith(error);
});

it("Windows PTY completion waits for readiness and the input socket callback", () => {
  const source = fs.readFileSync(
    "node_modules/node-pty/lib/windowsTerminal.js",
    "utf8",
  );
  const snippet = source.slice(
    source.indexOf("    WindowsTerminal.prototype.passportWrite ="),
    source.indexOf("    WindowsTerminal.prototype._write ="),
  );
  const deferred: (() => void)[] = [],
    done = vi.fn();
  let flush!: (error?: Error) => void;
  const receiver = {
    _agent: {
      inSocket: {
        write: vi.fn((_data, callback) => {
          flush = callback;
        }),
      },
    },
    _deferNoArgs(fn: () => void) {
      deferred.push(fn.bind(this));
    },
  };
  const context: any = { WindowsTerminal: function () {} };
  vm.runInNewContext(snippet, context);
  context.WindowsTerminal.prototype.passportWrite.call(
    receiver,
    Buffer.from("한글"),
    done,
  );
  expect(receiver._agent.inSocket.write).not.toHaveBeenCalled();
  deferred.shift()!();
  expect(done).not.toHaveBeenCalled();
  flush();
  expect(done).toHaveBeenCalledTimes(1);
});

it("delivers 4 MiB of Unicode through a real local PTY with an exact byte hash", async () => {
  const unit = "한글💻e\u0301";
  const text =
    unit.repeat(Math.floor(pasteTextLimit / Buffer.byteLength(unit))) +
    "a".repeat(pasteTextLimit % Buffer.byteLength(unit));
  const body = Buffer.from(text);
  expect(body.length).toBe(pasteTextLimit);
  const expected = Buffer.from(pasteStart + text + pasteEnd);
  const code = `process.stdin.setRawMode(true); const hash = require('node:crypto').createHash('sha256'); let bytes = 0; process.stdin.on('data', chunk => { bytes += chunk.length; hash.update(chunk); if (bytes >= ${expected.length}) { process.stdout.write('RESULT:' + bytes + ':' + hash.digest('hex') + '\\n'); process.stdin.pause(); } }); process.stdout.write('READY\\n');`;
  const terminal = pty.spawn(
    process.env.npm_node_execpath || process.execPath,
    ["-e", code],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      useConptyDll: process.platform === "win32",
      env: localTerminalEnv(),
    },
  );
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  const exit = new Promise<void>((resolve) =>
    terminal.onExit(() => setImmediate(resolve)),
  );
  const errors: Error[] = [];
  const queue = new TerminalInputQueue(
    "native",
    ptyInputWriter(terminal),
    () => {},
    (error) => errors.push(error),
    undefined,
    new InputBudget(),
  );
  try {
    await expect.poll(() => output, { timeout: 5000 }).toContain("READY");
    queue.paste(text, true, "generation");
    await expect
      .poll(() => output, { timeout: 10000 })
      .toContain(`RESULT:${expected.length}:${hash(expected)}`);
    await expect.poll(() => queue.busy).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    queue.dispose();
    terminal.kill();
    await exit;
  }
});
