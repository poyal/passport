import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeCleanly } from "../fixtures/electron-exit";

test("Windows drive root remains browsable around protected system files", async () => {
  test.skip(process.platform !== "win32", "Requires a Windows system drive.");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-drive-root-"),
  );
  const systemDirectory = process.env.SystemRoot || "C:\\Windows";
  const root = path.parse(systemDirectory).root;
  const systemName = new RegExp(
    `^${path.basename(systemDirectory).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i",
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
    await page.getByRole("button", { name: "호스트", exact: true }).click();
    await expect(page.locator(".hosts-view")).toBeVisible();
    await page.getByRole("button", { name: "파일", exact: true }).click();
    const input = page.getByLabel("왼쪽 경로", { exact: true });
    await input.fill(root);
    await input.press("Enter");
    await expect(
      page
        .getByRole("region", { name: "왼쪽 파일 패널" })
        .getByText(systemName),
    ).toBeVisible();
    await expect(input).toHaveValue(root);
    await expect(page.locator(".toast.error")).toHaveCount(0);
  } finally {
    try {
      await closeCleanly(application);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
