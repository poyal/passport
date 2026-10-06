import { test, expect } from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";

const suite = reusableApp({ name: "reuse-contract" });

test("reusing an app clears prior state and native mocks without replacing its process or primary window", async () => {
  const { application, page } = suite;
  const pid = application.process().pid;
  const baseline = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  await application.evaluate(
    ({ BrowserWindow, clipboard, net, shell, ipcMain }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const cp = process.getBuiltinModule("node:child_process") as any;
      const before = {
        read: clipboard.read,
        fetch: net.fetch,
        external: shell.openExternal,
        execFile: cp.execFile,
        focused: win.isFocused,
        handler: (ipcMain as any)._invokeHandlers.get("passport:call"),
      };
      (globalThis as any).__reuseOriginals = before;
      clipboard.read = async () => [];
      shell.openExternal = async () => {};
      cp.execFile = () => {
        throw Error("stale clipboard command");
      };
      win.isFocused = () => false;
      ipcMain.removeHandler("passport:call");
      ipcMain.handle("passport:call", (...args) => before.handler(...args));
    },
  );
  await page.evaluate(async () => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.settings.colorMode = "light";
    document.settings.notifications.desktop = "off";
    document.settings.terminal.autoLogLocal = true;
    await window.passport.call("save", document);
    localStorage.setItem("stale-fixture", "must disappear");
    sessionStorage.setItem("stale-fixture", "must disappear");
  });
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  const secondCreated = application.waitForEvent("window");
  await page.evaluate(() => window.passport.call("window.create", undefined));
  const second = await secondCreated;
  await expect(second.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  // App resources also use net.fetch; replace it only after both windows load.
  await application.evaluate(({ net }) => {
    net.fetch = async () => Response.json({ stale: true });
  });
  expect(application.windows()).toHaveLength(2);
  expect(
    await page.evaluate(() => window.passport.call("logs.list", undefined)),
  ).not.toEqual([]);

  await suite.reset();

  expect(application.process().pid).toBe(pid);
  expect(application.windows()).toEqual([page]);
  expect(second.isClosed()).toBe(true);
  const next = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  expect(next.windowId).toBe(baseline.windowId);
  expect(next.document).toEqual({
    ...baseline.document,
    revision: next.document.revision,
  });
  expect(next.sessionStates).toEqual([]);
  expect(
    await page.evaluate(() => window.passport.call("logs.list", undefined)),
  ).toEqual([]);
  expect(
    await page.evaluate(() => [
      localStorage.getItem("stale-fixture"),
      sessionStorage.getItem("stale-fixture"),
    ]),
  ).toEqual([null, null]);
  expect(
    await application.evaluate(
      ({ BrowserWindow, clipboard, net, shell, ipcMain }) => {
        const before = (globalThis as any).__reuseOriginals;
        const cp = process.getBuiltinModule("node:child_process") as any;
        return [
          clipboard.read === before.read,
          net.fetch === before.fetch,
          shell.openExternal === before.external,
          cp.execFile === before.execFile,
          BrowserWindow.getAllWindows()[0].isFocused === before.focused,
          (ipcMain as any)._invokeHandlers.get("passport:call") ===
            before.handler,
        ];
      },
    ),
  ).toEqual([true, true, true, true, true, true]);
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
});
