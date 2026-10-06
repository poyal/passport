import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { electron } from "../../scripts/e2e-electron.mjs";
import { recordElectronLifecycle } from "../../scripts/e2e-lifecycle.mjs";
import type { PassportDocument } from "../../src/shared/model";
import { closeCleanly } from "./electron-exit";

// One process and primary native window per spec, with an explicit reset between
// cases. Lifetime/persistence/launch-environment tests must use their own app.
export function reusableApp(options: {
  name: string;
  platform?: NodeJS.Platform;
  advanceClockMs?: number;
  env?: NodeJS.ProcessEnv;
}) {
  let application: ElectronApplication;
  let page: Page;
  let directory: string;
  let baseline: PassportDocument;
  let windowId: number;
  let pid: number;
  let uses = 0;
  const errors: string[] = [];
  const pageError = (error: Error) => errors.push(error.message);

  const restore = () =>
    application.evaluate(() => {
      (globalThis as any).__passportTestRestore();
    });

  async function reset() {
    expect(application.process().pid).toBe(pid);
    expect(application.process().exitCode).toBeNull();
    expect(
      page.isClosed(),
      "A reusable case must retain its primary window",
    ).toBe(false);
    await restore();
    // Tests may attach request/dialog listeners. Keep only the fixture's error
    // listener; reloading resets renderer state without creating a native window.
    page.removeAllListeners("dialog");
    page.removeAllListeners("request");
    page.removeAllListeners("pageerror");
    page.on("pageerror", pageError);
    await page.evaluate(async (initial) => {
      const boot = await window.passport.call("bootstrap", undefined);
      await window.passport.call("save", {
        ...initial,
        revision: boot.document.revision,
      });
      await window.passport.call("activity.clear", undefined);
      for (const log of await window.passport.call("logs.list", undefined))
        await window.passport.call("logs.delete", { id: log.id });
      for (const profile of boot.profiles)
        await window.passport.call("auth.delete", { id: profile.id });
      localStorage.clear();
      sessionStorage.clear();
    }, baseline);
    await application.evaluate(({ BrowserWindow }, id) => {
      for (const win of BrowserWindow.getAllWindows())
        if (win.id !== id) win.close();
      const win = BrowserWindow.fromId(id)!;
      win.setContentSize(1440, 900);
    }, windowId);
    await expect.poll(() => application.windows().length).toBe(1);
    await fs.rm(path.join(directory, "paste-images"), {
      recursive: true,
      force: true,
    });
    await page.reload();
    await expect(page.locator(".home-view")).toBeVisible();
    const fresh = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    expect(fresh.windowId).toBe(windowId);
    expect(fresh.document).toEqual({
      ...baseline,
      revision: fresh.document.revision,
    });
    expect(fresh.sessionStates).toEqual([]);
    expect(fresh.profiles).toEqual([]);
    expect(
      await page.evaluate(() =>
        window.passport.call("activity.list", undefined),
      ),
    ).toEqual([]);
  }

  test.beforeAll(async () => {
    test.skip(
      !!options.platform && process.platform !== options.platform,
      `Requires ${options.platform}.`,
    );
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `passport-${options.name}-`),
    );
    application = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        ...options.env,
        PASSPORT_DATA_DIR: directory,
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
    pid = application.process().pid!;
    page = await application.firstWindow();
    page.on("pageerror", pageError);
    await page.waitForSelector(".home-view");
    const boot = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    baseline = boot.document;
    windowId = boot.windowId;
    await application.evaluate(
      ({ BrowserWindow, clipboard, dialog, shell, net, ipcMain }, id) => {
        const cp = process.getBuiltinModule("node:child_process") as any;
        const win = BrowserWindow.fromId(id)!;
        const originals: (() => void)[] = [];
        const capture = (object: any, key: string) => {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          originals.push(() =>
            descriptor
              ? Object.defineProperty(object, key, descriptor)
              : Reflect.deleteProperty(object, key),
          );
        };
        for (const [object, keys] of [
          [clipboard, ["read", "readText", "writeText"]],
          [dialog, ["showMessageBox", "showOpenDialog", "showSaveDialog"]],
          [shell, ["openExternal"]],
          [net, ["fetch"]],
          [cp, ["execFile"]],
          [win, ["isFocused", "isVisible"]],
          [Date, ["now"]],
        ] as [any, string[]][])
          for (const key of keys) capture(object, key);
        const handler = (ipcMain as any)._invokeHandlers.get("passport:call");
        const state = globalThis as any;
        state.__passportTestRestore = () => {
          for (const restore of originals) restore();
          ipcMain.removeHandler("passport:call");
          ipcMain.handle("passport:call", handler);
        };
        const realNow = Date.now;
        let offset = 0;
        state.__passportTestAdvanceClock = (step: number) => {
          offset += step;
          Date.now = () => realNow() + offset;
        };
      },
      windowId,
    );
  });

  test.beforeEach(async ({}, info) => {
    errors.length = 0;
    if (uses) await reset();
    if (options.advanceClockMs)
      await application.evaluate(
        ({}, step) => (globalThis as any).__passportTestAdvanceClock(step),
        options.advanceClockMs,
      );
    if (uses++)
      recordElectronLifecycle({
        kind: "reuse",
        pid,
        windowId,
        test: info.title,
      });
    await info.attach("electron-session", {
      body: JSON.stringify({ pid, windowId, reuse: uses > 1 }),
      contentType: "application/json",
    });
  });

  test.afterEach(async () => {
    if (!application) return;
    try {
      const audit = await application.evaluate(
        () => (globalThis as any).__passportE2EWindowAudit,
      );
      if (audit) {
        expect(
          audit.focused,
          "Reusable E2E must not focus native windows",
        ).toBe(0);
        if (audit.mode === "hidden") expect(audit.shown).toBe(0);
      }
      expect(errors).toEqual([]);
    } finally {
      await restore();
    }
  });
  test.afterAll(async () => {
    try {
      if (application) await closeCleanly(application);
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  return {
    get application() {
      return application;
    },
    get page() {
      return page;
    },
    get directory() {
      return directory;
    },
    reset,
  };
}
