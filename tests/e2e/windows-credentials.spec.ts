import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostSchema } from "../../src/shared/model";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";

test("Windows DPAPI protects stored credentials and reconnects after restart", async () => {
  test.skip(process.platform !== "win32", "Requires Windows DPAPI.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-dpapi-"));
  const server = await sshFixture(directory);
  const profileId = randomUUID(),
    paneId = randomUUID(),
    workspaceId = randomUUID();
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "DPAPI fixture",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
    authId: profileId,
  });
  let application: ElectronApplication | undefined;
  const launch = async () => {
    application = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: path.join(directory, "data"),
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const page = await application.firstWindow();
    await expect(page.locator(".hosts-view")).toBeVisible();
    return page;
  };
  try {
    let page = await launch();
    expect(
      await application!.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable(),
      ),
    ).toBe(true);
    await page.evaluate(
      async ({ host, profileId, paneId, workspaceId }) => {
        await window.passport.call("auth.save", {
          id: profileId,
          name: "DPAPI fixture",
          username: "tester",
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        });
        const { document } = await window.passport.call("bootstrap", undefined);
        document.hosts = [host];
        document.settings.confirmNewHostKeys = false;
        document.workspaces = [
          {
            id: workspaceId,
            name: "DPAPI fixture",
            root: { kind: "pane", id: paneId, hostId: host.id },
          },
        ];
        await window.passport.call("save", document);
      },
      { host, profileId, paneId, workspaceId },
    );
    await closeCleanly(application!);
    application = undefined;
    const db = new Database(path.join(directory, "data", "passport.sqlite"), {
      readonly: true,
    });
    try {
      const row = db
        .prepare("SELECT secret FROM credentials WHERE id=?")
        .get(profileId) as { secret: Buffer };
      expect(Buffer.isBuffer(row.secret)).toBe(true);
      expect(row.secret.length).toBeGreaterThan(0);
      expect(row.secret.includes(Buffer.from("test-only-password"))).toBe(
        false,
      );
      expect(() => JSON.parse(row.secret.toString("utf8"))).toThrow();
    } finally {
      db.close();
    }
    page = await launch();
    const bootstrap = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    expect(bootstrap.profiles).toContainEqual(
      expect.objectContaining({ id: profileId, hasSecret: true }),
    );
    expect(bootstrap.sessionStates).toEqual([]);
    await page.evaluate(
      async ({ paneId, hostId }) => {
        await window.passport.call("session.connect", { id: paneId, hostId });
      },
      { paneId, hostId: host.id },
    );
    await expect.poll(() => server.shells.length).toBe(1);
  } finally {
    try {
      if (application) await closeCleanly(application);
    } finally {
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
