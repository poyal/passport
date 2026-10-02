import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { electron } from "../../scripts/e2e-electron.mjs";
import { closeCleanly } from "../fixtures/electron-exit";
import {
  writeMacPasteboard,
  releaseMacPasteboard,
} from "../fixtures/mac-pasteboard";
import { quotePastePaths } from "../../src/shared/paste";

let application: ElectronApplication, page: Page, directory: string;
let nativeBoard: string;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const pasteKey = process.platform === "darwin" ? "Meta+v" : "Control+Shift+v";
test.beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-paste-e2e-"));
  nativeBoard = `io.passport.test.${path.basename(directory)}`;
  if (process.platform === "darwin") await writeMacPasteboard(nativeBoard, []);
  application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: directory,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  page = await application.firstWindow();
  if (process.platform === "darwin") {
    await application.evaluate(({}, name) => {
      const cp = process.getBuiltinModule("node:child_process") as any;
      const original = cp.execFile;
      cp.execFile = (file: string, args: string[], ...rest: unknown[]) => {
        if (
          file === "/usr/bin/osascript" &&
          args.includes("JavaScript") &&
          args.some((arg) =>
            arg.includes("NSPasteboardURLReadingFileURLsOnlyKey"),
          )
        )
          args = [...args, name];
        return original(file, args, ...rest);
      };
    }, nativeBoard);
  }
  await page.waitForSelector(".home-view");
  await page.keyboard.press(`${mod}+n`);
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  // Capture inputs without forwarding them to the real shell. Clipboard data is
  // injected at the Electron API, so hidden tests never overwrite the user's copy.
  await application.evaluate(({ ipcMain }) => {
    const state = globalThis as any;
    state.__pasteInputs = [];
    const handle = ipcMain.handle.bind(ipcMain);
    const handlers = (ipcMain as any)._invokeHandlers;
    const original = handlers.get("passport:call");
    ipcMain.removeHandler("passport:call");
    handle("passport:call", (event, name, input) => {
      if (
        name === "session.input" &&
        process.platform === "win32" &&
        ["\x1b[?1;2c", "\x1b[I", "\x1b[O"].includes(input.data)
      )
        return original(event, name, input);
      if (name === "session.input") {
        state.__pasteInputs.push(input);
        return { ok: true, value: undefined };
      }
      return original(event, name, input);
    });
  });
});
test.afterEach(async () => {
  try {
    if (application) await closeCleanly(application);
  } finally {
    if (process.platform === "darwin") await releaseMacPasteboard(nativeBoard);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Finder app and folder copy inserts absolute paths when Electron exposes only names", async () => {
  test.skip(process.platform !== "darwin", "Requires macOS AppKit pasteboard.");
  const files = [
    path.join(directory, "Passport.app"),
    path.join(directory, "한 글 폴더"),
    path.join(directory, "a'b.txt"),
  ];
  await fs.mkdir(files[0]);
  await fs.mkdir(files[1]);
  await fs.writeFile(files[2], "fixture");
  await writeMacPasteboard(nativeBoard, files);
  await inject({ "text/plain": "Passport.app\n한 글 폴더\na'b.txt" });
  await paste();
  await expect.poll(async () => (await inputs()).length).toBe(1);
  const text = (await inputs())[0].data.replace(/\x1b\[(?:200|201)~/g, "");
  expect(text.normalize("NFC")).toBe(quotePastePaths(files, "zsh"));
  expect(text).not.toMatch(/[\r\n]/);
});

async function inject(values: Record<string, string>, delay = 0) {
  await application.evaluate(
    ({ clipboard }, { values, delay }) => {
      clipboard.read = async () => {
        (globalThis as any).__pasteReads =
          ((globalThis as any).__pasteReads || 0) + 1;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return [
          {
            types: Object.keys(values),
            getType: async (type: string) => new Blob([values[type]]),
          },
        ] as Electron.ClipboardItem[];
      };
    },
    { values, delay },
  );
}
const inputs = () =>
  application.evaluate(
    () => (globalThis as any).__pasteInputs as { id: string; data: string }[],
  );
async function paste() {
  await page.locator(".view:not([hidden]) .xterm-helper-textarea").focus();
  await page.keyboard.press(pasteKey);
}

test("terminal paste preserves literal text and file paths without duplicate input or Enter", async () => {
  await inject({ "text/plain": "echo {{literal}}\n" });
  await paste();
  await expect.poll(async () => (await inputs()).length).toBe(1);
  expect((await inputs())[0].data.replace(/\x1b\[(?:200|201)~/g, "")).toBe(
    "echo {{literal}}",
  );
  const files = [
    path.join(directory, "한 글.png"),
    path.join(directory, "a'b.png"),
  ];
  await inject({
    "text/uri-list": files.map((file) => pathToFileURL(file).href).join("\r\n"),
    "text/plain": "WRONG_FILE_NAME",
  });
  await paste();
  await expect.poll(async () => (await inputs()).length).toBe(2);
  const inserted = (await inputs())[1].data;
  expect(inserted).toContain("한 글.png");
  expect(inserted).not.toContain("WRONG_FILE_NAME");
  expect(inserted).not.toMatch(/[\r\n]/);
  await inject({ "text/plain": "ONE_GESTURE" });
  await page.evaluate(() => {
    const area = document.querySelector(
      ".view:not([hidden]) .xterm-helper-textarea",
    )!;
    area.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        code: "KeyV",
        metaKey: navigator.platform.includes("Mac"),
        ctrlKey: !navigator.platform.includes("Mac"),
        shiftKey: !navigator.platform.includes("Mac"),
        bubbles: true,
        cancelable: true,
      }),
    );
    area.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(async () => (await inputs()).length).toBe(3);
  await page.waitForTimeout(150);
  expect(await inputs()).toHaveLength(3);
  await page.keyboard.press(
    process.platform === "darwin" ? "Control+v" : "Alt+v",
  );
  await expect.poll(async () => (await inputs()).length).toBe(4);
  expect((await inputs())[3].data).toBe(
    process.platform === "darwin" ? "\x16" : "\x1bv",
  );
  if (process.platform === "win32") {
    await inject({ "text/plain": "WINDOWS_CTRL_V" });
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await inputs()).length).toBe(5);
  }
});

test("image paste saves readable PNG and pending paste stays with its original connected pane", async () => {
  await application.evaluate(({ clipboard, nativeImage }) => {
    const png = nativeImage
      .createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
      .toPNG();
    clipboard.read = async () =>
      [
        {
          types: ["image/png", "text/plain"],
          getType: async (type: string) =>
            new Blob([
              type === "image/png" ? new Uint8Array(png) : "WRONG_IMAGE_TEXT",
            ]),
        },
      ] as Electron.ClipboardItem[];
  });
  await paste();
  await expect.poll(async () => (await inputs()).length).toBe(1);
  const saved = await fs.readdir(path.join(directory, "paste-images"));
  expect(saved).toHaveLength(1);
  const bytes = await fs.readFile(
    path.join(directory, "paste-images", saved[0]),
  );
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect((await inputs())[0].data).toContain(saved[0]);
  const source = (await inputs())[0].id;
  await inject({ "text/plain": "ORIGINAL_PANE_ONLY" }, 400);
  await paste();
  await page.keyboard.press(`${mod}+n`);
  await expect.poll(async () => (await inputs()).length).toBe(2);
  expect((await inputs())[1]).toMatchObject({ id: source });
  expect((await inputs())[1].data).toContain("ORIGINAL_PANE_ONLY");
  const boot = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  expect(boot.document.workspaces).toHaveLength(2);
  await inject({ "text/plain": "MUST_NOT_PASTE_AFTER_CLOSE" }, 400);
  await paste();
  const active = boot.document.workspaces[1].root.id;
  await page.evaluate(
    (id) => window.passport.call("session.close", { id }),
    active,
  );
  await page.waitForTimeout(600);
  expect(await inputs()).toHaveLength(2);
  await expect(
    page.evaluate(() =>
      window.passport.call("clipboard.terminal", { id: "not-owned" }),
    ),
  ).rejects.toThrow();
});
