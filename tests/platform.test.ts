import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { selectPlatform } from "../src/main/platform";
import { createDarwinTerminal } from "../src/main/platform/darwin/terminal";
import {
  createWindowsTerminal,
  windowsExecutableArchitecture,
} from "../src/main/platform/win32/terminal";
import { createDarwinClipboard } from "../src/main/platform/darwin/clipboard";
import { createWindowsClipboard } from "../src/main/platform/win32/clipboard";
import { createDarwinActivityEndpoint } from "../src/main/platform/darwin/activity-endpoint";
import { createWindowsActivityEndpoint } from "../src/main/platform/win32/activity-endpoint";
import { bashPromptMarkers } from "../src/main/platform/shared/terminal";
import { osClipboardFormat } from "../src/main/clipboard-files";
import { testWindowOptions } from "../src/main/test-window";
import type {
  DesktopPlatform,
  WindowMode,
} from "../src/main/platform/contracts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const identity = {
  shell: "passport-bash" as const,
  sessionInstanceId: "test-generation",
};

it("selects explicit desktop implementations and never maps an unknown OS to macOS", () => {
  expect(selectPlatform("darwin").terminal.id).toBe("darwin");
  expect(selectPlatform("win32").terminal.id).toBe("win32");
  for (const id of ["linux", "unknown", "__proto__", "constructor"])
    expect(() => selectPlatform(id)).toThrow("지원하지 않는 운영체제");
});

it("constructs terminal adapters without accessing the host and caches the Mac login shell lazily", () => {
  const exists = vi.fn(() => true),
    loginShell = vi.fn(() => "/custom/zsh");
  const mac = createDarwinTerminal({
    arch: "arm64",
    env: {},
    exists,
    loginShell,
  });
  createWindowsTerminal({ arch: "x64", env: {}, exists });
  expect(exists).not.toHaveBeenCalled();
  expect(loginShell).not.toHaveBeenCalled();
  expect(mac.shells("/resources")[0]).toMatchObject({
    id: "default",
    path: "/custom/zsh",
    architecture: "arm64",
  });
  mac.shells("/resources");
  expect(loginShell).toHaveBeenCalledTimes(1);
  expect(mac.defaultArgs("/custom/zsh")).toEqual(["-l"]);
  expect(mac.posixPath("/tmp/한 글")).toBe("/tmp/한 글");
});

it("keeps Mac fallback selection and missing-shell diagnostics", () => {
  const mac = createDarwinTerminal({
    env: { SHELL: "/custom/bash" },
    exists: () => false,
    loginShell: () => undefined,
  });
  expect(mac.shells("/resources")[0]).toMatchObject({
    path: "/custom/bash",
    available: false,
    reason: "이 기기에 설치되어 있지 않습니다.",
  });
  expect(
    createDarwinTerminal({
      env: {},
      exists: () => true,
      loginShell: () => undefined,
    }).shells("/resources")[0].path,
  ).toBe("/bin/zsh");
});

it("uses Windows paths and aliases even when inspected on a Mac host", () => {
  const win = createWindowsTerminal({
    arch: "arm64",
    env: { SystemRoot: "D:\\Windows", ProgramFiles: "E:\\Programs" },
    exists: (file) => !file.endsWith("pwsh.exe"),
    architecture: () => "arm64",
  });
  const shells = win.shells("D:\\Passport\\terminal");
  expect(shells.find((s) => s.id === "passport-bash")?.path).toBe(
    "D:\\Passport\\terminal\\runtime\\arm64\\bin\\bash.exe",
  );
  expect(shells.find((s) => s.id === "default")?.path).toBe(
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(shells.find((s) => s.id === "powershell")?.path).toBe(
    shells.find((s) => s.id === "default")?.path,
  );
  expect(shells.find((s) => s.id === "pwsh")?.available).toBe(false);
  expect(win.defaultArgs("D:\\Windows\\cmd.exe")).toEqual([]);
  expect(win.defaultArgs("E:\\Programs\\pwsh.exe")).toEqual(["-NoLogo"]);
  expect(win.posixPath("D:\\한 글\\project")).toBe("/d/한 글/project");
  expect(win.profileKey("Path")).toBe("path");
  const installed = createWindowsTerminal({
    env: {},
    exists: () => true,
    architecture: () => "x64",
  });
  expect(
    installed.shells("C:\\runtime").find((s) => s.id === "default")?.path,
  ).toContain("PowerShell\\7\\pwsh.exe");
});

it("reads the target PE architecture and rejects corrupt or absent executables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "passport-pe-"));
  const file = path.join(dir, "helper.exe");
  try {
    const bytes = Buffer.alloc(128);
    bytes.write("MZ");
    bytes.writeUInt32LE(64, 60);
    bytes.writeUInt32LE(0x4550, 64);
    for (const [machine, expected] of [
      [0xaa64, "arm64"],
      [0x8664, "x64"],
      [0x14c, "x86"],
      [0, "unknown"],
    ] as const) {
      bytes.writeUInt16LE(machine, 68);
      fs.writeFileSync(file, bytes);
      expect(windowsExecutableArchitecture(file)).toBe(expected);
    }
    fs.writeFileSync(file, "bad");
    expect(windowsExecutableArchitecture(file)).toBe("unknown");
    expect(windowsExecutableArchitecture(file + ".absent")).toBe("unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("sets Windows Bash launch state without overwriting an explicit CLI Bash path", () => {
  const win = createWindowsTerminal({ arch: "arm64", exists: () => true });
  const env = {
    PROMPT_COMMAND: "user_prompt",
    PS0: "user-start",
    CLAUDE_CODE_GIT_BASH_PATH: "D:\\custom\\bash.exe",
  } as NodeJS.ProcessEnv;
  win.configureEnvironment(env, identity, "D:\\runtime");
  expect(env).toMatchObject({
    MSYSTEM: "CLANGARM64",
    CHERE_INVOKING: "1",
    CLAUDE_CODE_GIT_BASH_PATH: "D:\\custom\\bash.exe",
  });
  expect(env.PROMPT_COMMAND).toContain("user_prompt; printf");
  expect(env.PS0).toBe(
    bashPromptMarkers(identity.sessionInstanceId).command + "user-start",
  );
  const normal: NodeJS.ProcessEnv = {};
  win.configureEnvironment(
    normal,
    { ...identity, shell: "cmd" },
    "D:\\runtime",
  );
  expect(normal.CLAUDE_CODE_GIT_BASH_PATH).toBe(
    "D:\\runtime\\runtime\\arm64\\bin\\bash.exe",
  );
  expect(normal.MSYSTEM).toBeUndefined();
  const unchanged = { PATH: "/bin" };
  createDarwinTerminal().configureEnvironment(unchanged, identity, "/tmp");
  expect(unchanged).toEqual({ PATH: "/bin" });
});

it("isolates per-session Bash resize correction and recognizes chunked prompt markers", () => {
  const win = createWindowsTerminal();
  const first = win.createPtyBehavior(identity),
    second = win.createPtyBehavior(identity);
  const markers = bashPromptMarkers(identity.sessionInstanceId);
  for (const char of markers.prompt) first.observeOutput(char);
  first.resized();
  second.resized();
  expect(first.input("\x1b[I")).toBe("\x1b[I");
  expect(first.input("p")).toBe("\x00p");
  expect(first.input("rintf\r")).toBe("rintf\r");
  expect(second.input("Q")).toBe("Q");
  first.observeOutput(markers.command + "\x1b]133;A\x07");
  first.resized();
  expect(first.input("Q")).toBe("Q");
  first.observeOutput(bashPromptMarkers("another-generation").prompt);
  expect(first.input("R")).toBe("R");
  first.observeOutput(markers.prompt);
  expect(first.input("x")).toBe("\x00x");
  const plain = win.createPtyBehavior({ ...identity, shell: "pwsh" });
  plain.observeOutput(markers.prompt);
  plain.resized();
  expect(plain.input("p")).toBe("p");
});

it("sends POSIX escalation only while alive and cancels it on exit", () => {
  vi.useFakeTimers();
  const kill = vi.fn();
  const mac = createDarwinTerminal();
  const first = mac.createPtyBehavior();
  first.terminate({ kill }, () => true);
  expect(kill.mock.calls).toEqual([[]]);
  vi.advanceTimersByTime(1000);
  expect(kill.mock.calls).toEqual([[], ["SIGKILL"]]);
  kill.mockClear();
  const second = mac.createPtyBehavior();
  second.terminate({ kill }, () => true);
  second.dispose();
  vi.advanceTimersByTime(1000);
  expect(kill.mock.calls).toEqual([[]]);
  kill.mockClear();
  createWindowsTerminal()
    .createPtyBehavior(identity)
    .terminate({ kill }, () => true);
  vi.advanceTimersByTime(1000);
  expect(kill.mock.calls).toEqual([[]]);
});

it.each([undefined, "hidden", "passive"] as WindowMode[])(
  "configures Windows identity before showing a window in mode %s",
  (mode) => {
    const desktop = selectPlatform("win32").desktop;
    const events: string[] = [];
    let ready: (() => void) | undefined;
    const win = {
      setAppDetails: vi.fn(() => events.push("details")),
      once: vi.fn((_event, callback) => {
        events.push("ready-listener");
        ready = callback;
      }),
      show: vi.fn(() => events.push("shown")),
    };
    const context = {
      appPath: "D:\\Passport",
      resourcesPath: "D:\\Passport\\resources",
      executable: "D:\\Passport\\Passport.exe",
      packaged: true,
    };
    const options = {
      ...desktop.windowOptions(context),
      ...testWindowOptions(mode),
    };
    expect(options.show).toBe(false);
    desktop.configureWindow(
      win as unknown as Parameters<DesktopPlatform["configureWindow"]>[0],
      context,
      mode,
    );
    expect(win.setAppDetails.mock.calls[0]).toEqual([
      expect.objectContaining({
        appIconPath: "D:\\Passport\\resources\\icon.ico",
        relaunchCommand: '"D:\\Passport\\Passport.exe"',
      }),
    ]);
    expect(events).toEqual(mode ? ["details"] : ["details", "ready-listener"]);
    ready?.();
    expect(win.show).toHaveBeenCalledTimes(mode ? 0 : 1);
    if (mode)
      expect(options).toMatchObject({ focusable: false, skipTaskbar: true });
  },
);

it("keeps app initialization, Mac window lifetime and notification destinations distinct", async () => {
  const app = { setActivationPolicy: vi.fn(), setAppUserModelId: vi.fn() };
  const mac = selectPlatform("darwin").desktop,
    win = selectPlatform("win32").desktop;
  mac.initialize(app, undefined);
  expect(app.setActivationPolicy).not.toHaveBeenCalled();
  mac.initialize(app, "hidden");
  expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  win.initialize(app, "hidden");
  expect(app.setAppUserModelId).toHaveBeenCalledWith("io.passport.desktop");
  expect(mac.quitOnLastWindow).toBe(false);
  expect(win.quitOnLastWindow).toBe(true);
  const shell = { openExternal: vi.fn(async () => {}) };
  await mac.openNotificationSettings(shell);
  await win.openNotificationSettings(shell);
  expect(shell.openExternal.mock.calls).toEqual([
    ["x-apple.systempreferences:com.apple.Notifications-Settings.extension"],
    ["ms-settings:notifications"],
  ]);
});

const item = (type: string, text: string | Buffer) => ({
  types: [type],
  getType: async () =>
    new Blob([typeof text === "string" ? text : new Uint8Array(text)]),
});
it("reads Explorer paths through a fixed command and detects clipboard replacement", async () => {
  const file = "D:\\한 글\\a'b.png";
  const run = vi.fn(async () => JSON.stringify([file]));
  const clipboard = createWindowsClipboard(run, { SystemRoot: "D:\\Windows" });
  const entry = item(
    osClipboardFormat("FileNameW"),
    Buffer.from(file + "\0", "utf16le"),
  );
  expect(await clipboard.readFiles([entry])).toEqual([file]);
  expect(run.mock.calls[0]).toEqual([
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    expect.arrayContaining([
      "-STA",
      "-Command",
      expect.stringContaining("GetFileDropList"),
    ]),
  ]);
  expect(JSON.stringify(run.mock.calls)).not.toContain(file);
  run.mockResolvedValue(JSON.stringify(["D:\\changed.txt"]));
  await expect(clipboard.readFiles([entry])).rejects.toThrow("클립보드가 변경");
});

it("decodes Mac plist via stdin and falls back to literal file URLs", async () => {
  const run = vi.fn(async () => JSON.stringify(["/tmp/한 글"]));
  const clipboard = createDarwinClipboard(run);
  expect(
    await clipboard.readFiles([
      item(osClipboardFormat("NSFilenamesPboardType"), "plist"),
    ]),
  ).toEqual(["/tmp/한 글"]);
  expect(run.mock.calls[0]).toEqual([
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", "-"],
    Buffer.from("plist"),
  ]);
  expect(
    await clipboard.readFiles([item("text/uri-list", "file:///tmp/a%20b")]),
  ).toEqual(["/tmp/a b"]);
  expect(
    await clipboard.readFiles([item("text/uri-list", "https://example.com/")]),
  ).toBeUndefined();
});

it("allocates independent Windows pipe names without filesystem resources", () => {
  const first = createWindowsActivityEndpoint(),
    second = createWindowsActivityEndpoint();
  expect(first.address).toMatch(/^\\\\\.\\pipe\\passport-/);
  expect(first.address).not.toBe(second.address);
  first.listening();
  first.dispose();
  first.dispose();
});

it.skipIf(process.platform === "win32")(
  "secures a Unix notification socket and removes only its owned directory",
  async () => {
    // macOS TMPDIR is already long; nested fixture paths exceed sun_path.
    const root = fs.mkdtempSync("/tmp/passport-endpoint-");
    const endpoint = createDarwinActivityEndpoint(root);
    const server = net.createServer();
    try {
      expect(fs.statSync(path.dirname(endpoint.address)).mode & 0o777).toBe(
        0o700,
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.address, resolve);
      });
      endpoint.listening();
      expect(fs.statSync(endpoint.address).mode & 0o777).toBe(0o600);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      endpoint.dispose();
      endpoint.dispose();
      expect(fs.existsSync(root)).toBe(true);
      expect(fs.existsSync(path.dirname(endpoint.address))).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
