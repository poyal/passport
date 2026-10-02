import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { electron } from "../../scripts/e2e-electron.mjs";
import { e2eMode } from "../../scripts/e2e-mode.mjs";
import { closeCleanly } from "../fixtures/electron-exit";

test("isolated windows accept terminal input and move workspaces without native focus", async ({}, info) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-background-"),
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
  const state = () =>
    application.evaluate(({ BrowserWindow }) => ({
      audit: (globalThis as any).__passportE2EWindowAudit,
      windows: BrowserWindow.getAllWindows().map((win) => ({
        visible: win.isVisible(),
        focused: win.isFocused(),
        focusable: win.isFocusable(),
      })),
    }));
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "1 / 1 연결",
    );
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("printf 'BACKGROUND_%s\\n' INPUT_OK");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(
      "BACKGROUND_INPUT_OK",
    );
    const next = application.waitForEvent("window");
    await page.getByRole("button", { name: "운영 도구", exact: true }).click();
    await page
      .getByRole("button", { name: "연결을 유지하며 이동", exact: true })
      .click();
    const second = await next;
    await expect(second.locator(".xterm-rows")).toContainText(
      "BACKGROUND_INPUT_OK",
    );
    // The second-instance route previously called show() and focus().
    await application.evaluate(({ app }) => {
      app.emit("second-instance", {} as any, [], process.cwd());
    });
    const expected = {
      visible: e2eMode() === "passive",
      focused: false,
      focusable: false,
    };
    await expect.poll(state).toEqual({
      audit: {
        mode: e2eMode(),
        created: 2,
        shown: e2eMode() === "passive" ? 2 : 0,
        focused: 0,
      },
      windows: [expected, expected],
    });
    await second.screenshot({
      path: info.outputPath("background-terminal.png"),
    });
    await info.attach("native-window-state", {
      body: JSON.stringify(await state(), null, 2),
      contentType: "application/json",
    });
    if (process.platform === "win32") {
      const icons = await application.evaluate(({ app, BrowserWindow }) => ({
        path: app.isPackaged
          ? `${process.resourcesPath}/icon.ico`
          : `${app.getAppPath()}/build/icon.ico`,
        handles: BrowserWindow.getAllWindows()
          .map((win) =>
            win.getNativeWindowHandle().readBigUInt64LE().toString(),
          )
          .join(","),
      }));
      const report = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          "scripts/windows-icon-smoke.ps1",
          "-IconPath",
          icons.path,
          "-WindowHandles",
          icons.handles,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15000 },
      );
      await info.attach("native-window-icons", {
        body: report,
        contentType: "application/json",
      });
    }
  } finally {
    try {
      await closeCleanly(application);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
