import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reusableApp } from "../fixtures/reusable-app";
import { waitForLocalPrompt } from "../fixtures/terminal-ready";
import { closeCleanly } from "../fixtures/electron-exit";
import { electron } from "../../scripts/e2e-electron.mjs";

const boot = (page: Page) =>
  page.evaluate(() => window.passport.call("bootstrap", undefined));
async function newWindow(application: ElectronApplication, page: Page) {
  const opened = application.waitForEvent("window");
  const id = await page.evaluate(() =>
    window.passport.call("window.create", undefined),
  );
  const next = await opened;
  await waitForLocalPrompt(next);
  const state = await boot(next);
  const workspace = state.document.workspaces.find(
    (w) => state.workspaceOwners[w.id] === id,
  )!;
  if (workspace.root.kind !== "pane")
    throw new Error("Expected single local pane");
  return {
    page: next,
    id,
    workspaceId: workspace.id,
    paneId: workspace.root.id,
  };
}
async function closeWindow(
  application: ElectronApplication,
  id: number,
  response = 1,
) {
  await application.evaluate(
    ({ BrowserWindow, dialog }, { id, response }) => {
      dialog.showMessageBox = async () => ({
        response,
        checkboxChecked: false,
      });
      BrowserWindow.fromId(id)!.close();
    },
    { id, response },
  );
}

test.describe("individual window close", () => {
  const suite = reusableApp({ name: "window-close" });

  test("closing a window removes only its tabs and resume records while cancellation keeps connections", async () => {
    const { application, page } = suite;
    await page.evaluate(async () => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.sessionResume = true;
      await window.passport.call("save", b.document);
    });
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await waitForLocalPrompt(page);
    const first = await boot(page);
    const second = await newWindow(application, page);
    await expect
      .poll(async () => (await boot(page)).resumeSessions.map((s) => s.id))
      .toContain(second.paneId);
    const before = await boot(page);
    await closeWindow(application, second.id, 0);
    await expect
      .poll(
        async () =>
          (await boot(second.page)).sessionStates.find(
            (s) => s.id === second.paneId,
          )?.status,
      )
      .toBe("connected");
    expect((await boot(page)).document).toEqual(before.document);
    await closeWindow(application, second.id);
    await expect.poll(() => second.page.isClosed()).toBe(true);
    const after = await boot(page);
    expect(after.document.workspaces).toEqual(first.document.workspaces);
    expect(after.workspaceOwners).toEqual(first.workspaceOwners);
    expect(after.resumeSessions.some((s) => s.id === second.paneId)).toBe(
      false,
    );
    expect(after.sessionStates.some((s) => s.id === second.paneId)).toBe(false);
    await page.locator(".view:not([hidden]) textarea").press("Control+c");
    await page.keyboard.type("echo CLOSE_SURVIVOR");
    await page.keyboard.press("Enter");
    await expect(page.locator(".view:not([hidden]) .xterm-rows")).toContainText(
      "CLOSE_SURVIVOR",
    );
    // A subsequent save must not adopt or resurrect the closed window's tabs.
    await page.evaluate(async () => {
      const b = await window.passport.call("bootstrap", undefined);
      await window.passport.call("save", b.document);
    });
    expect((await boot(page)).document.workspaces).toEqual(
      first.document.workspaces,
    );
  });

  test("a failed tab deletion keeps the window and live terminal until a successful retry", async () => {
    const { application, page } = suite;
    const second = await newWindow(application, page);
    const before = await boot(page);
    const failWrites = (enabled: boolean) =>
      application.evaluate(({ app }, enabled) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(app.getAppPath() + "/package.json");
        const Database = require("better-sqlite3");
        const db = new Database(app.getPath("userData") + "/passport.sqlite");
        try {
          db.exec(
            enabled
              ? "CREATE TRIGGER fail_close_save BEFORE UPDATE ON metadata BEGIN SELECT RAISE(FAIL, 'CLOSE_SAVE_FAILED'); END"
              : "DROP TRIGGER IF EXISTS fail_close_save",
          );
        } finally {
          db.close();
        }
      }, enabled);
    await failWrites(true);
    try {
      await closeWindow(application, second.id);
      await expect(second.page.locator(".toast.error")).toContainText(
        "CLOSE_SAVE_FAILED",
      );
      expect((await boot(page)).document).toEqual(before.document);
      expect(
        (await boot(page)).sessionStates.find((s) => s.id === second.paneId)
          ?.status,
      ).toBe("connected");
    } finally {
      await failWrites(false);
    }
    await closeWindow(application, second.id);
    await expect.poll(() => second.page.isClosed()).toBe(true);
    expect((await boot(page)).document.workspaces).toEqual([]);
  });

  for (const closing of ["source", "target"] as const) {
    test(`closing a transfer ${closing} rejects delayed snapshots without moving or resurrecting tabs`, async () => {
      const { application, page } = suite;
      await page
        .getByRole("button", { name: "새 로컬 터미널", exact: true })
        .click();
      await waitForLocalPrompt(page);
      const first = await boot(page);
      const second = await newWindow(application, page);
      const source = closing === "source" ? second.page : page;
      const workspaceId =
        closing === "source"
          ? second.workspaceId
          : first.document.workspaces[0].id;
      await application.evaluate(({ ipcMain }) => {
        const g = globalThis as any;
        const original = (ipcMain as any)._invokeHandlers.get("passport:call");
        g.__closeSnapshotWaiting = false;
        g.__closeReleaseSnapshot = undefined;
        ipcMain.removeHandler("passport:call");
        ipcMain.handle("passport:call", async (event, name, input) => {
          if (name === "window.snapshot") {
            g.__closeSnapshotWaiting = true;
            await new Promise<void>((resolve) => {
              g.__closeReleaseSnapshot = resolve;
            });
          }
          return original(event, name, input);
        });
      });
      try {
        await source.evaluate(
          (args) => window.passport.call("window.move", args),
          {
            workspaceId,
            target: closing === "source" ? first.windowId : second.id,
          },
        );
        await expect
          .poll(() =>
            application.evaluate(
              () => (globalThis as any).__closeSnapshotWaiting,
            ),
          )
          .toBe(true);
        await closeWindow(application, second.id);
        await expect.poll(() => second.page.isClosed()).toBe(true);
      } finally {
        await application.evaluate(() =>
          (globalThis as any).__closeReleaseSnapshot?.(),
        );
      }
      if (closing === "target")
        await expect(page.locator(".toast.error")).toContainText("만료");
      const after = await boot(page);
      expect(after.document.workspaces).toEqual(first.document.workspaces);
      expect(after.workspaceOwners).toEqual(first.workspaceOwners);
      expect(
        after.sessionStates.find(
          (s) => s.id === first.document.workspaces[0].root.id,
        )?.status,
      ).toBe("connected");
    });
  }
});

test("application quit preserves every window's tabs for the next launch", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-close-quit-"),
  );
  const launch = () =>
    electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: directory,
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await waitForLocalPrompt(page);
    await newWindow(application, page);
    const expected = (await boot(page)).document.workspaces;
    await closeCleanly(application);
    application = await launch();
    page = await application.firstWindow();
    await page.waitForSelector(".app-main");
    const restored = await boot(page);
    expect(restored.document.workspaces).toEqual(expected);
    expect(Object.values(restored.workspaceOwners)).toEqual(
      expected.map(() => restored.windowId),
    );
  } finally {
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("macOS last window close preserves tabs when the app is activated again", async () => {
  test.skip(
    process.platform !== "darwin",
    "macOS keeps the application running without windows.",
  );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-close-last-"),
  );
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: directory,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await waitForLocalPrompt(page);
    const before = await boot(page);
    await closeWindow(application, before.windowId);
    await expect.poll(() => application.windows().length).toBe(0);
    const opened = application.waitForEvent("window");
    await application.evaluate(({ app }) => app.emit("activate"));
    const next = await opened;
    await next.waitForSelector(".app-main");
    expect((await boot(next)).document.workspaces).toEqual(
      before.document.workspaces,
    );
    // Two close requests in the same turn must still preserve the final
    // window, even before the first native window has finished closing.
    const extra = await newWindow(application, next);
    await extra.page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      extra.paneId,
    );
    const concurrent = await boot(next);
    const remainingId = concurrent.windowId;
    await next.evaluate(
      (id) => window.passport.call("session.close", { id }),
      before.document.workspaces[0].root.id,
    );
    await application.evaluate(
      ({ BrowserWindow, dialog }, { extraId, remainingId }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
        (globalThis as any).__windowCloseOrder = [];
        for (const id of [extraId, remainingId])
          BrowserWindow.fromId(id)!.once("closed", () =>
            (globalThis as any).__windowCloseOrder.push(id),
          );
        BrowserWindow.fromId(extraId)!.close();
        BrowserWindow.fromId(remainingId)!.close();
      },
      { extraId: extra.id, remainingId },
    );
    await expect.poll(() => application.windows().length).toBe(0);
    const lastClosed = await application.evaluate(
      () => (globalThis as any).__windowCloseOrder.at(-1) as number,
    );
    const reopened = application.waitForEvent("window");
    await application.evaluate(({ app }) => app.emit("activate"));
    const final = await reopened;
    await final.waitForSelector(".app-main");
    expect((await boot(final)).document.workspaces).toEqual(
      concurrent.document.workspaces.filter(
        (w) => concurrent.workspaceOwners[w.id] === lastClosed,
      ),
    );
  } finally {
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
