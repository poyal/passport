import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
