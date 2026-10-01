import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeCleanly } from "../fixtures/electron-exit";
import { LOCAL_HOST_ID } from "../../src/shared/advanced";

for (const mode of ["active", "closed", "reopened"] as const) {
  test(`quits normally with four ${mode} native PTYs`, async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-quit-"),
    );
    const application = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: { ...process.env, PASSPORT_DATA_DIR: directory },
    });
    try {
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      });
      const page = await application.firstWindow();
      await page.getByRole("button", { name: "호스트", exact: true }).click();
      await expect(page.locator(".hosts-view")).toBeVisible();
      await page.evaluate(
        async ({ hostId, mode }) => {
          const b = await window.passport.call("bootstrap", undefined);
          const workspaces = Array.from({ length: 4 }, (_, i) => ({
            id: crypto.randomUUID(),
            name: `종료 검증 ${i + 1}`,
            root: {
              kind: "pane" as const,
              id: crypto.randomUUID(),
              hostId,
              local: { shell: "default" as const, cwd: "" },
            },
          }));
          b.document.workspaces = workspaces;
          await window.passport.call("save", b.document);
          for (const w of workspaces) {
            const id = w.root.id;
            await window.passport.call("session.connect", { id, hostId });
            await window.passport.call("session.input", {
              id,
              data: "echo QUIT_PTY_READY\r",
            });
            if (mode !== "active")
              await window.passport.call("session.close", { id });
            if (mode === "reopened")
              await window.passport.call("session.connect", { id, hostId });
          }
        },
        { hostId: LOCAL_HOST_ID, mode },
      );
    } finally {
      try {
        await closeCleanly(application);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });
}

test("shares one instance per data directory and allows isolated data directories", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-instance-"),
  );
  const env = {
    ...process.env,
    PASSPORT_DATA_DIR: directory,
    PASSPORT_DISABLE_UPDATE_CHECK: "1",
  };
  const args = process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."];
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args,
    env,
  });
  let isolated: typeof application | undefined;
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    const original = await page.evaluate(
      async () => (await window.passport.call("bootstrap", undefined)).document,
    );
    const executable = await application.evaluate(({ app }) => {
      (globalThis as any).secondInstances = 0;
      app.on("second-instance", () => {
        (globalThis as any).secondInstances++;
      });
      return process.execPath;
    });
    second = spawn(executable, args, { env, stdio: "ignore" });
    const [code, signal] = await once(second, "exit");
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    await expect
      .poll(() =>
        application.evaluate(() => (globalThis as any).secondInstances),
      )
      .toBe(1);
    expect(
      await page.evaluate(
        async () =>
          (await window.passport.call("bootstrap", undefined)).document,
      ),
    ).toEqual(original);
    isolated = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args,
      env: { ...env, PASSPORT_DATA_DIR: path.join(directory, "isolated") },
    });
    await (await isolated.firstWindow()).waitForSelector(".home-view");
    expect(isolated.process().pid).not.toBe(application.process().pid);
  } finally {
    if (second && second.exitCode === null && second.signalCode === null)
      second.kill();
    if (isolated) await closeCleanly(isolated);
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("closes live terminals without parsing externally changed settings", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-close-settings-"),
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
  const errors = path.join(directory, "uncaught.txt");
  try {
    await application.evaluate(({ dialog }, errors) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      process.on("uncaughtException", (error) => {
        process.getBuiltinModule("fs").appendFileSync(errors, String(error));
      });
    }, errors);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "새 터미널", exact: true }).click();
    await page
      .getByRole("button", { name: "로컬 터미널 열기", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined))
              .sessionStates[0]?.status,
        ),
      )
      .toBe("connected");
    await application.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule("module");
      const path = process.getBuiltinModule("path");
      const require = createRequire(
        path.join(app.getAppPath(), "package.json"),
      );
      const Database = require("better-sqlite3");
      const db = new Database(
        path.join(app.getPath("userData"), "passport.sqlite"),
      );
      try {
        const value = JSON.parse(
          db.prepare("SELECT value FROM metadata WHERE id=1").get().value,
        );
        value.version = 999;
        db.prepare("UPDATE metadata SET value=? WHERE id=1").run(
          JSON.stringify(value),
        );
      } finally {
        db.close();
      }
    });
    await expect(
      page.evaluate(() => window.passport.call("bootstrap", undefined)),
    ).rejects.toThrow("expected 2");
  } finally {
    try {
      await closeCleanly(application);
      expect(await fs.readFile(errors, "utf8").catch(() => "")).toBe("");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
