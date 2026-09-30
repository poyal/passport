// Uses a disposable profile and the public GitHub release feed; no server login.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { closeCleanly } from "../tests/fixtures/electron-exit.ts";

const executablePath = process.argv[2];
assert.ok(executablePath, "Pass the packaged executable path");
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "passport-updates-smoke-"),
);
const env = { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") };
delete env.PASSPORT_DISABLE_UPDATE_CHECK;
let application;
try {
  application = await electron.launch({ executablePath, args: [], env });
  const page = await application.firstWindow();
  await expect(page.locator(".hosts-view")).toBeVisible();
  const runtime = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
  }));
  assert.equal(runtime.packaged, true);
  // Only bootstrap is used: a completed check must have originated at startup.
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined)).updateState,
        );
        return ["current", "available", "error"].includes(state.status);
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const state = await page.evaluate(
    async () =>
      (await window.passport.call("bootstrap", undefined)).updateState,
  );
  assert.ok(["current", "available"].includes(state.status), state.message);
  assert.equal(state.currentVersion, runtime.version);
  assert.match(state.latestVersion, /^\d+\.\d+\.\d+$/);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "About", exact: true })
    .click();
  await expect(page.locator(".update-result")).toContainText(state.message);
  await page.locator(".update-card").scrollIntoViewIfNeeded();
  const screenshotDirectory = `release/recheck-updates-v${runtime.version}`;
  await fs.mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDirectory, "packaged-startup.png"),
  });
  await closeCleanly(application);
  application = undefined;
  console.log(
    JSON.stringify(
      {
        startupUpdateCheck: "passed",
        manualChecks: 0,
        source: "public GitHub Releases",
        runtime,
        state,
        shutdownExitCode: 0,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (application) await closeCleanly(application);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
