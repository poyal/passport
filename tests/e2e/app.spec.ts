import { electron } from "../../scripts/e2e-electron.mjs";
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";
let application: ElectronApplication,
  page: Page,
  directory: string,
  server: Awaited<ReturnType<typeof sshFixture>>;
test.beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-e2e-"));
  await fs.mkdir(path.join(directory, "remote"));
  server = await sshFixture(path.join(directory, "remote"));
  application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
    timeout: 30000,
  });
  page = await application.firstWindow();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page.waitForLoadState("domcontentloaded");
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
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
test("host CRUD, live SSH, split session preservation, themes, and persistence", async () => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "호스트", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      node: typeof (window as any).require,
      language: document.documentElement.lang,
    })),
  ).toEqual({ node: "undefined", language: "ko" });
  await page.getByRole("button", { name: "새 호스트", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill("로컬 검증 서버");
  await page.getByLabel("서버 주소", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("포트", { exact: true }).fill(String(server.port));
  await page.getByLabel("사용자 이름", { exact: true }).fill("tester");
  await page.getByRole("button", { name: "호스트 저장", exact: true }).click();
  await expect(page.locator(".host-row")).toHaveCount(1);
  await page.getByRole("button", { name: "SSH 연결", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "연결", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  await expect.poll(() => server.shells.length).toBe(1);
  const original = await page
    .locator(".terminal-pane")
    .getAttribute("data-pane-id");
  await page.getByRole("button", { name: "터미널 분할", exact: true }).click();
  await page.getByLabel("연결할 호스트 검색").fill("로컬 검증");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /로컬 검증 서버/ })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "연결", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .terminal-pane")).toHaveCount(
    2,
  );
  await expect.poll(() => server.shells.length).toBe(2);
  expect(
    await page.locator(".terminal-pane").first().getAttribute("data-pane-id"),
  ).toBe(original);
  await page
    .locator(".terminal-pane")
    .first()
    .getByRole("button", { name: "집중 보기", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .terminal-pane")).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "분할 복원", exact: true }).click();
  await expect(page.locator(".view:not([hidden]) .terminal-pane")).toHaveCount(
    2,
  );
  expect(server.shells.length).toBe(2);
  await page
    .locator(".terminal-pane")
    .last()
    .getByRole("button", { name: "새 탭으로 분리", exact: true })
    .click();
  await expect(page.locator(".workspace-tab")).toHaveCount(2);
  expect(server.shells.length).toBe(2);
  await page.getByRole("button", { name: "외형", exact: true }).click();
  await expect(page.locator(".toolbox .theme-item")).toHaveCount(12);
  await page
    .locator(".toolbox")
    .getByRole("button", { name: "Nord", exact: true })
    .click();
  await page.getByRole("button", { name: "스니펫", exact: true }).click();
  await page.getByRole("button", { name: "새 스니펫", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("이름", { exact: true })
    .fill("원문 검증");
  await page
    .getByRole("dialog")
    .getByLabel("명령어", { exact: true })
    .fill("printf test\n");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await page.getByRole("button", { name: "현재 탭 전체", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() => server.input.join(""))
    .toBe("\x1b[200~printf test\x1b[201~");
  await page
    .getByRole("button", { name: "도구 패널 닫기", exact: true })
    .click();
  const drag = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator(".workspace-tab")
    .last()
    .dispatchEvent("dragstart", { dataTransfer: drag });
  await page
    .locator(".workspace-tab")
    .first()
    .dispatchEvent("dragover", { dataTransfer: drag });
  await expect(page.locator(".workspace-tab").first()).toHaveClass(/active/);
  const destination = page
    .locator(".view:not([hidden]) .terminal-pane")
    .first();
  const rect = (await destination.boundingBox())!;
  await destination.dispatchEvent("drop", {
    dataTransfer: drag,
    clientX: rect.x + rect.width - 12,
    clientY: rect.y + rect.height / 2,
  });
  await expect(page.locator(".workspace-tab")).toHaveCount(1);
  await expect(page.locator(".view:not([hidden]) .terminal-pane")).toHaveCount(
    2,
  );
  expect(server.shells.length).toBe(2);
  await page.screenshot({ path: test.info().outputPath("terminal.png") });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "라이트", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "다크", exact: true }).click();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await expect(page.locator(".host-row")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("hosts.png") });
  await page.reload();
  await expect(page.locator(".host-row")).toHaveCount(1);
  await expect(page.locator(".workspace-tab")).toHaveCount(1);
  const saved = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  await closeCleanly(application);
  application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  page = await application.firstWindow();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".workspace-tab")).toHaveCount(1);
  const restored = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  expect(restored.document.workspaces).toEqual(saved.document.workspaces);
  expect(restored.workspaceOwners[restored.document.workspaces[0].id]).toBe(
    restored.windowId,
  );
  expect(restored.sessionStates).toEqual([]);
  await page.locator(".workspace-tab>button").first().click();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "0 / 2 연결",
  );
  await page.evaluate(
    async ({ id, hostId }) =>
      window.passport.call("session.connect", {
        id,
        hostId,
        secret: {
          type: "password",
          password: "test-only-password",
          privateKey: "",
          passphrase: "",
        },
      }),
    { id: original!, hostId: restored.document.hosts[0].id },
  );
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 2 연결",
  );
  expect(errors).toEqual([]);
});
test("independent file panels, context menus, local copy and queue", async () => {
  const left = path.join(directory, "left"),
    right = path.join(directory, "right");
  await fs.mkdir(left);
  await fs.mkdir(right);
  await fs.writeFile(path.join(left, "한글 파일.txt"), "actual local transfer");
  await page.getByRole("button", { name: "파일", exact: true }).click();
  const leftInput = page.getByLabel("왼쪽 경로"),
    rightInput = page.getByLabel("오른쪽 경로");
  await expect(leftInput).not.toHaveValue("");
  await expect(rightInput).not.toHaveValue("");
  const rightPanel = page.getByRole("region", { name: "오른쪽 파일 패널" });
  await expect(
    rightPanel.getByRole("button", { name: "새로고침", exact: true }),
  ).toBeEnabled();
  await leftInput.fill(left);
  await leftInput.press("Enter");
  const row = page
    .getByRole("region", { name: "왼쪽 파일 패널" })
    .locator("tr")
    .filter({ hasText: "한글 파일.txt" });
  await expect(row).toBeVisible();
  // Hold the destination's real listing until the copy controls have been
  // checked. A fast source must never copy into the destination's old folder.
  const navigation = await application.evaluateHandle(
    ({ ipcMain, BrowserWindow }, target) => {
      const handlers = (ipcMain as any)._invokeHandlers;
      const original = handlers.get("passport:call");
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const originalSend = contents.send;
      let completedEvent: any;
      contents.send = function (channel, ...args) {
        if (
          channel === "passport:event" &&
          args[0]?.kind === "transfer" &&
          args[0].job.state === "completed"
        ) {
          completedEvent = args[0];
          return;
        }
        return originalSend.call(this, channel, ...args);
      };
      const deliverCompletion = () => {
        contents.send = originalSend;
        if (completedEvent) {
          originalSend.call(contents, "passport:event", completedEvent);
          completedEvent = undefined;
        }
      };
      let pending = false;
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      ipcMain.removeHandler("passport:call");
      ipcMain.handle("passport:call", async (event, name, input) => {
        if (name === "files.list" && input.path === target && !pending) {
          pending = true;
          await gate;
        }
        return original(event, name, input);
      });
      return {
        pending: () => pending,
        resume: () => resume(),
        completed: () => !!completedEvent,
        deliverCompletion,
        restore: () => {
          resume();
          deliverCompletion();
          ipcMain.removeHandler("passport:call");
          ipcMain.handle("passport:call", original);
          return (
            handlers.get("passport:call") === original &&
            contents.send === originalSend
          );
        },
      };
    },
    right,
  );
  try {
    await rightInput.fill(right);
    await rightInput.press("Enter");
    await expect
      .poll(() => navigation.evaluate((state) => state.pending()))
      .toBe(true);
    await row.click({ button: "right" });
    const copy = page.getByRole("menuitem", {
      name: "오른쪽 폴더로 복사",
      exact: true,
    });
    await expect(copy).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "왼쪽 → 오른쪽", exact: true }),
    ).toBeDisabled();
    await navigation.evaluate((state) => state.resume());
    await expect(copy).toBeEnabled();
    await expect(copy).toHaveAttribute(
      "title",
      new RegExp(right.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
    );
    await copy.click();
    await expect
      .poll(() => navigation.evaluate((state) => state.completed()))
      .toBe(true);
    // A real completed transfer must refresh the list without replacing a
    // path the user is already typing. The new file proves refresh finished.
    await fs.writeFile(
      path.join(left, "refresh-check.txt"),
      "refresh evidence",
    );
    await leftInput.fill(directory);
    await navigation.evaluate((state) => state.deliverCompletion());
    await expect(
      page
        .getByRole("region", { name: "왼쪽 파일 패널" })
        .getByText("refresh-check.txt", { exact: true }),
    ).toBeVisible();
    await expect(leftInput).toHaveValue(directory);
    await expect(leftInput).toBeEnabled();
    await leftInput.press("Enter");
    await expect(
      page
        .getByRole("region", { name: "왼쪽 파일 패널" })
        .getByText("left", { exact: true }),
    ).toBeVisible();
  } finally {
    expect(await navigation.evaluate((state) => state.restore())).toBe(true);
    await navigation.dispose();
  }
  await expect
    .poll(async () => {
      try {
        return await fs.readFile(path.join(right, "한글 파일.txt"), "utf8");
      } catch {
        return "";
      }
    })
    .toBe("actual local transfer");
  await expect(page.locator(".transfer-row.completed")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("files.png") });
});
test("long file lists stay above the queue and scroll independently at both window sizes", async () => {
  const folder = path.join(directory, "scroll-files");
  await fs.mkdir(folder);
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      fs.writeFile(
        path.join(folder, `항목-${String(i).padStart(3, "0")}.txt`),
        "scroll test",
      ),
    ),
  );
  await page.getByRole("button", { name: "파일", exact: true }).click();
  for (const label of ["왼쪽 경로", "오른쪽 경로"]) {
    await page.getByLabel(label).fill(folder);
    await page.getByLabel(label).press("Enter");
  }
  const left = page.getByRole("region", { name: "왼쪽 파일 패널" });
  const right = page.getByRole("region", { name: "오른쪽 파일 패널" });
  // File enumeration must finish before checking the rendered row count.
  for (const panel of [left, right])
    await expect(panel).toHaveAttribute("aria-busy", "false", {
      timeout: 30_000,
    });
  await expect(left.locator("tbody tr")).toHaveCount(101);
  await expect(right.locator("tbody tr")).toHaveCount(101);
  for (const size of [
    [1024, 680],
    [1440, 900],
  ]) {
    await application.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0].setSize(width, height);
    }, size);
    for (const collapsed of [false, true]) {
      if (collapsed)
        await page
          .getByRole("button", { name: "전송 목록 접기", exact: true })
          .click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const queue = document
              .querySelector(".transfer-queue")!
              .getBoundingClientRect();
            const status = document
              .querySelector(".app-status")!
              .getBoundingClientRect();
            return [...document.querySelectorAll(".file-panel")].every(
              (panel) => {
                const list = panel.querySelector(".file-table-scroll")!;
                const bounds = list.getBoundingClientRect();
                const footer = panel
                  .querySelector(".panel-status")!
                  .getBoundingClientRect();
                return (
                  bounds.height > 80 &&
                  list.scrollHeight > list.clientHeight &&
                  bounds.bottom <= footer.top + 1 &&
                  footer.bottom <= queue.top + 1 &&
                  queue.bottom <= status.top + 1
                );
              },
            );
          }),
        )
        .toBe(true);
      await left.locator(".file-table-scroll").evaluate((e) => {
        e.scrollTop = 0;
      });
      await right.locator(".file-table-scroll").evaluate((e) => {
        e.scrollTop = 0;
      });
      await left.locator(".file-table-scroll").hover();
      await page.mouse.wheel(0, 10000);
      await expect
        .poll(() =>
          left.locator(".file-table-scroll").evaluate((e) => e.scrollTop),
        )
        .toBeGreaterThan(100);
      expect(
        await right.locator(".file-table-scroll").evaluate((e) => e.scrollTop),
      ).toBe(0);
      await expect(
        left.getByText("항목-099.txt", { exact: true }),
      ).toBeInViewport();
      await left
        .getByText("항목-099.txt", { exact: true })
        .click({ button: "right" });
      await expect(page.getByRole("menu")).toBeInViewport();
      await page.keyboard.press("Escape");
    }
    await page
      .getByRole("button", { name: "전송 목록 펼치기", exact: true })
      .click();
  }
  await page.screenshot({ path: test.info().outputPath("file-scroll.png") });
});
test("opening the app never requests access to the operating system secret store", async () => {
  const probe = await application.evaluateHandle(({ safeStorage }) => {
    const original = safeStorage.isEncryptionAvailable;
    let calls = 0;
    safeStorage.isEncryptionAvailable = () => {
      calls++;
      throw new Error("startup must not request Keychain access");
    };
    return {
      restore() {
        safeStorage.isEncryptionAvailable = original;
        return calls;
      },
    };
  });
  try {
    await page.reload();
    await page.getByRole("button", { name: "호스트", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "호스트", exact: true }),
    ).toBeVisible();
    const bootstrap = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    expect(bootstrap.document.version).toBe(2);
    expect(await probe.evaluate((p) => p.restore())).toBe(0);
  } finally {
    await probe.evaluate((p) => p.restore());
    await probe.dispose();
  }
});
