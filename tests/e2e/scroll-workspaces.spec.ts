import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostSchema, type Workspace } from "../../src/shared/model";
import { panes } from "../../src/shared/layout";
import { cloneWorkspaces } from "../../src/shared/workspace-templates";
import { closeCleanly } from "../fixtures/electron-exit";
import { sshFixture } from "../fixtures/ssh-server";

let application: ElectronApplication,
  page: Page,
  directory: string,
  server: Awaited<ReturnType<typeof sshFixture>>;
const errors: string[] = [];
const hostId = randomUUID(),
  profileId = randomUUID();
const original: Workspace[] = [
  {
    id: randomUUID(),
    name: "Build servers",
    root: {
      kind: "split",
      id: randomUUID(),
      direction: "horizontal",
      ratio: 0.32,
      children: [
        { kind: "pane", id: randomUUID(), hostId },
        { kind: "pane", id: randomUUID(), hostId },
      ],
    },
  },
  {
    id: randomUUID(),
    name: "Monitoring",
    root: { kind: "pane", id: randomUUID(), hostId },
  },
];
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
  page = await application.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".hosts-view")).toBeVisible();
  await application.evaluate(({ safeStorage, dialog }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (text) => Buffer.from(text);
    safeStorage.decryptString = (buffer) => buffer.toString();
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
};
const resize = async (width: number, height: number) => {
  await application.evaluate(
    ({ BrowserWindow }, [width, height]) =>
      BrowserWindow.getAllWindows()[0].setSize(width, height),
    [width, height],
  );
};
test.beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-scroll-workspaces-"),
  );
  server = await sshFixture(directory);
  await Promise.all(
    Array.from({ length: 160 }, (_, i) =>
      fs.writeFile(
        path.join(directory, `entry-${String(i).padStart(3, "0")}.txt`),
        "fixture",
      ),
    ),
  );
  await launch();
  const host = hostSchema.parse({
    id: hostId,
    name: "Fixture CentOS",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
    authId: profileId,
  });
  await page.evaluate(
    async ({ host, profileId, original }) => {
      await window.passport.call("auth.save", {
        id: profileId,
        name: "Fixture credentials",
        username: "tester",
        secret: {
          type: "password",
          password: "test-only-password",
          privateKey: "",
          passphrase: "",
        },
      });
      const { document } = await window.passport.call("bootstrap", undefined);
      document.hosts = [
        host,
        ...Array.from({ length: 100 }, (_, i) => ({
          ...host,
          id: crypto.randomUUID(),
          name: `Fixture Linux ${String(i).padStart(3, "0")}`,
        })),
      ];
      document.workspaces = original;
      document.settings.confirmNewHostKeys = false;
      await window.passport.call("save", document);
    },
    { host, profileId, original },
  );
  await application.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule(
        "module",
      ) as typeof import("node:module"),
      fs = process.getBuiltinModule("fs") as typeof import("node:fs"),
      path = process.getBuiltinModule("path") as typeof import("node:path"),
      { randomUUID } = process.getBuiltinModule(
        "crypto",
      ) as typeof import("node:crypto");
    const require = createRequire(path.join(app.getAppPath(), "package.json"));
    const Database = require("better-sqlite3");
    const directory = app.getPath("userData"),
      db = new Database(path.join(directory, "passport.sqlite"));
    const text = Array.from(
      { length: 2500 },
      (_, i) => `LOG LINE ${String(i).padStart(4, "0")} normal output 한글\r\n`,
    ).join("");
    for (let i = 0; i < 70; i++) {
      const id = randomUUID();
      fs.writeFileSync(path.join(directory, "logs", `${id}.log`), text);
      db.prepare(
        "INSERT INTO session_logs(id,name,started,bytes) VALUES(?,?,?,?)",
      ).run(
        id,
        `Fixture server ${i} · tester@localhost`,
        Date.now() - i * 1000,
        Buffer.byteLength(text),
      );
    }
    db.close();
  });
});
test.afterAll(async () => {
  try {
    if (application) await closeCleanly(application);
  } finally {
    await server?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

test("file action triggers toggle, dismiss, restore focus and stay in bounds while scrolling", async ({}, info) => {
  await page.getByRole("button", { name: "파일", exact: true }).click();
  for (const label of ["왼쪽 경로", "오른쪽 경로"]) {
    await page.getByLabel(label).fill(directory);
    await page.getByLabel(label).press("Enter");
  }
  await expect(
    page
      .locator(".file-panel")
      .first()
      .getByText("entry-159.txt", { exact: true }),
  ).toBeAttached();
  await expect(
    page
      .locator(".file-panel")
      .last()
      .getByText("entry-159.txt", { exact: true }),
  ).toBeAttached();
  for (const size of [
    [1024, 680],
    [1440, 900],
  ]) {
    await resize(size[0], size[1]);
    for (const label of ["왼쪽 파일 패널", "오른쪽 파일 패널"]) {
      const panel = page.getByRole("region", { name: label }),
        trigger = panel.getByRole("button", { name: "작업", exact: true });
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await trigger.click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.press("Enter");
      await expect(page.getByRole("menu")).toBeVisible();
      const rect = await page.getByRole("menu").boundingBox();
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(
        await page.evaluate(() => innerHeight),
      );
      await page.locator(".files-toolbar").click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await trigger.click();
      await panel.locator(".file-table-scroll").evaluate((e) => {
        e.scrollTop += 100;
      });
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  }
  await page.screenshot({
    path: info.outputPath("file-panels.png"),
    animations: "disabled",
  });
});

test("log list and output fill equal height and scroll independently at both themes and window sizes", async ({}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "세션 로그", exact: true })
    .click();
  await expect(page.locator(".log-list button")).toHaveCount(70);
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(async (mode) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.settings.colorMode = mode;
      await window.passport.call("save", document);
    }, mode);
    for (const [width, height] of [
      [1024, 680],
      [1440, 900],
      [1920, 1200],
    ]) {
      await resize(width, height);
      await page.locator(".log-list").evaluate((e) => {
        e.scrollTop = 0;
      });
      await page.locator(".log-list button").first().click();
      await expect(page.locator(".log-reader pre")).toContainText(
        "LOG LINE 2499",
      );
      await expect
        .poll(() =>
          page.evaluate(() => {
            const list = document.querySelector(".log-list")!,
              reader = document.querySelector(".log-reader")!,
              output = reader.querySelector("pre")!,
              content = document.querySelector(".settings-content")!;
            const a = list.getBoundingClientRect(),
              b = reader.getBoundingClientRect(),
              status = document
                .querySelector(".app-status")!
                .getBoundingClientRect();
            return (
              Math.abs(a.bottom - b.bottom) < 2 &&
              a.bottom < status.top &&
              a.height > 200 &&
              list.scrollHeight > list.clientHeight &&
              output.scrollHeight > output.clientHeight &&
              content.scrollHeight <= content.clientHeight + 1
            );
          }),
        )
        .toBe(true);
      await page.locator(".log-reader pre").hover();
      await page.mouse.wheel(0, 1500);
      await expect
        .poll(() =>
          page.locator(".log-reader pre").evaluate((e) => e.scrollTop),
        )
        .toBeGreaterThan(100);
      expect(await page.locator(".log-list").evaluate((e) => e.scrollTop)).toBe(
        0,
      );
      const outputPosition = await page
        .locator(".log-reader pre")
        .evaluate((e) => e.scrollTop);
      await page.locator(".log-list").hover();
      await page.mouse.wheel(0, 100000);
      await expect
        .poll(() => page.locator(".log-list").evaluate((e) => e.scrollTop))
        .toBeGreaterThan(100);
      expect(
        await page.locator(".log-reader pre").evaluate((e) => e.scrollTop),
      ).toBe(outputPosition);
      await expect(page.locator(".log-list button").last()).toBeInViewport();
      await page.screenshot({
        path: info.outputPath(`logs-${mode}-${width}.png`),
        animations: "disabled",
      });
    }
  }
});

test("SSH chooser keeps local controls aligned and only the host list scrolls", async ({}, info) => {
  for (const [width, height] of [
    [1024, 680],
    [1440, 900],
  ]) {
    await resize(width, height);
    await page.getByRole("button", { name: "새 SSH 탭", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "SSH 연결 열기" });
    await expect(dialog.locator(".connection-chooser button")).toHaveCount(101);
    const geometry = await dialog.evaluate((e) => {
      const select = e
          .querySelector(".local-shell-choice select")!
          .getBoundingClientRect(),
        button = e
          .querySelector(".local-shell-choice > button")!
          .getBoundingClientRect();
      return {
        bottoms: Math.abs(select.bottom - button.bottom),
        outside: e.scrollHeight - e.clientHeight,
      };
    });
    expect(geometry.bottoms).toBeLessThan(2);
    expect(geometry.outside).toBeLessThanOrEqual(1);
    await dialog.locator(".connection-chooser").hover();
    await page.mouse.wheel(0, 100000);
    await expect(
      dialog.locator(".connection-chooser button").last(),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: "호스트 관리로 이동", exact: true }),
    ).toBeInViewport();
    await expect(dialog.getByLabel("연결할 호스트 검색")).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`ssh-chooser-${width}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
  }
});

test("saved workspaces preserve tab order, focus and split ratios, reopen without sharing live IDs, and persist on restart", async ({}, info) => {
  await page
    .locator(".workspace-tab")
    .first()
    .locator("button")
    .first()
    .click();
  await page.locator(".terminal-pane").nth(1).click();
  await page.getByRole("button", { name: "스페이스", exact: true }).click();
  await page.getByRole("button", { name: "현재 창 저장", exact: true }).click();
  await page.getByRole("dialog").locator("input").fill("Build and monitor");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "적용", exact: true })
    .click();
  await expect(page.locator(".workspace-template-row")).toHaveCount(1);
  const saved = await page.evaluate(
    async () =>
      (await window.passport.call("bootstrap", undefined)).document
        .workspaceTemplates[0],
  );
  expect(saved.workspaces.map((w) => w.name)).toEqual([
    "Build servers",
    "Monitoring",
  ]);
  expect(saved.workspaces[0].root).toMatchObject({
    direction: "horizontal",
    ratio: 0.32,
  });
  expect(saved.activePaneId).toBe(panes(saved.workspaces[0].root)[1].id);
  await page
    .getByRole("button", { name: "Build and monitor 배치만 열기", exact: true })
    .click();
  await expect(page.locator(".workspace-tab")).toHaveCount(4);
  expect(server.shells).toHaveLength(0);
  const restored = await page.evaluate(
    async () =>
      (await window.passport.call("bootstrap", undefined)).document.workspaces,
  );
  expect(restored[2].root).toMatchObject({ ratio: 0.32 });
  expect(
    new Set(restored.flatMap((w) => panes(w.root).map((p) => p.id))).size,
  ).toBe(6);
  await page.getByRole("button", { name: "스페이스", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Build and monitor 스페이스 열고 연결",
      exact: true,
    })
    .click();
  await expect.poll(() => server.shells.length).toBe(3);
  await expect(page.locator(".workspace-tab")).toHaveCount(6);
  await page.getByRole("button", { name: "스페이스", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("workspace-library.png"),
    animations: "disabled",
  });
  await closeCleanly(application);
  await launch();
  await page.getByRole("button", { name: "스페이스", exact: true }).click();
  await expect(page.locator(".workspace-template-row")).toHaveCount(1);
  expect(server.shells).toHaveLength(3);
  await page
    .getByRole("button", { name: "Build and monitor 이름 변경", exact: true })
    .click();
  await page.getByRole("dialog").locator("input").fill("Daily operations");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "적용", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Daily operations 배치만 열기",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Daily operations 스페이스 삭제",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "확인", exact: true })
    .click();
  await expect(page.locator(".workspace-template-row")).toHaveCount(0);
  await expect(page.locator(".workspace-tab")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("long workspace libraries scroll without moving controls and refuse to exceed terminal capacity", async ({}, info) => {
  const templates = Array.from({ length: 60 }, (_, i) => ({
    id: randomUUID(),
    name: `Saved workspace ${String(i).padStart(2, "0")}`,
    ...cloneWorkspaces(
      original,
      original[0].id,
      panes(original[0].root)[0].id,
      randomUUID,
    ),
  }));
  await page.evaluate(async (templates) => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.workspaceTemplates = templates;
    document.workspaces = Array.from({ length: 32 }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `Capacity ${i}`,
      root: {
        kind: "pane",
        id: crypto.randomUUID(),
        hostId: document.hosts[0].id,
      },
    }));
    await window.passport.call("save", document);
  }, templates);
  await page.getByRole("button", { name: "스페이스", exact: true }).click();
  for (const [width, height] of [
    [1024, 680],
    [1440, 900],
  ]) {
    await resize(width, height);
    await page.locator(".workspace-template-list").hover();
    await page.mouse.wheel(0, 100000);
    await expect(
      page.locator(".workspace-template-row").last(),
    ).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "현재 창 저장", exact: true }),
    ).toBeInViewport();
    expect(
      await page
        .locator(".workspace-library")
        .evaluate(
          (e) =>
            e.scrollHeight <= e.clientHeight + 1 &&
            e.scrollWidth <= e.clientWidth + 1,
        ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`workspace-scroll-${width}.png`),
      animations: "disabled",
    });
  }
  await page
    .getByRole("button", {
      name: "Saved workspace 59 배치만 열기",
      exact: true,
    })
    .click();
  await expect(page.locator(".toast")).toContainText("최대 32개");
  await expect(page.locator(".workspace-tab")).toHaveCount(32);
  expect(server.shells).toHaveLength(3);
  await page
    .getByRole("button", {
      name: "Saved workspace 59 현재 창으로 갱신",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "확인", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await window.passport.call("bootstrap", undefined)
          ).document.workspaceTemplates.at(-1)!.workspaces.length,
      ),
    )
    .toBe(32);
  expect(errors).toEqual([]);
});
