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
import { randomUUID } from "node:crypto";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";
import { closeCleanly } from "../fixtures/electron-exit";
import { waitForLocalPrompt } from "../fixtures/terminal-ready";
let application: ElectronApplication,
  page: Page,
  directory: string,
  server: Awaited<ReturnType<typeof sshFixture>>;
const hostId = randomUUID(),
  paneA = randomUUID(),
  paneB = randomUUID(),
  workspace = randomUUID();
const errors: string[] = [];
test.beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-advanced-e2e-"),
  );
  server = await sshFixture(directory);
  application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  page = await application.firstWindow();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  page.on("pageerror", (e) => errors.push(e.message));
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  await expect(page.locator(".hosts-view")).toBeVisible();
  const host = hostSchema.parse({
    id: hostId,
    name: "후속 검증",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
  });
  await page.evaluate(
    async ({ host, paneA, paneB, workspace }) => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.hosts = [host];
      b.document.workspaces = [
        {
          id: workspace,
          name: "후속 작업",
          root: {
            kind: "split",
            id: crypto.randomUUID(),
            direction: "horizontal",
            ratio: 0.5,
            children: [
              { kind: "pane", id: paneA, hostId: host.id },
              { kind: "pane", id: paneB, hostId: host.id },
            ],
          },
        },
      ];
      await window.passport.call("save", b.document);
    },
    { host, paneA, paneB, workspace },
  );
  await page.locator(".workspace-tab").click();
  for (const id of [paneA, paneB])
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
      { id, hostId },
    );
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "2 / 2 연결",
  );
});
test.afterAll(async () => {
  try {
    if (application) await closeCleanly(application);
  } finally {
    await server?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

test("broadcast uses physical keys only, explicit execution records history, logs start automatically", async () => {
  await page
    .locator(`[data-pane-id="${paneA}"] .xterm-helper-textarea`)
    .focus();
  await page.getByRole("button", { name: "운영 도구", exact: true }).click();
  for (const checkbox of await page
    .locator(".toolbox .check-label input[type=checkbox]")
    .all())
    await checkbox.check();
  await page
    .getByRole("button", { name: "동시 입력 켜기", exact: true })
    .click();
  server.input.splice(0);
  await page
    .locator(`[data-pane-id="${paneA}"] .xterm-helper-textarea`)
    .focus();
  await page.keyboard.press("a");
  await expect.poll(() => server.input.join("")).toBe("aa");
  server.input.splice(0);
  server.shells[0].write("\x1b[5n");
  await expect.poll(() => server.input.join("")).toBe("\x1b[0n");
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page.locator(".workspace-tab").click();
  server.input.splice(0);
  await page
    .locator(`[data-pane-id="${paneA}"] .xterm-helper-textarea`)
    .focus();
  await page.keyboard.press("b");
  await expect.poll(() => server.input.join("")).toBe("b");
  const initialLogs = await page.evaluate(() =>
    window.passport.call("logs.list", undefined),
  );
  expect(initialLogs).toHaveLength(2);
  expect(initialLogs.every((l) => l.recording)).toBe(true);
  server.shells[0].write("\r\nLOG_MARKER_한글\r\n");
  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        const logs = await window.passport.call("logs.list", undefined);
        return (
          await Promise.all(
            logs.map((l) => window.passport.call("logs.read", { id: l.id })),
          )
        )
          .map((l) => l.text)
          .join("\n");
      });
    })
    .toContain("LOG_MARKER_한글");
  await page.locator(".toolbox textarea").fill("printf '{{name}}'");
  await page
    .getByRole("button", { name: "실행 미리보기", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("name", { exact: true })
    .fill("한글");
  server.input.splice(0);
  await page.getByRole("button", { name: "명령 실행", exact: true }).click();
  await expect.poll(() => server.input.join("")).toBe("printf '한글'\r");
  expect(
    await page.evaluate(() =>
      window.passport.call("command.suggest", { query: "printf" }),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: "printf '한글'" }),
    ]),
  );
  await page
    .getByRole("button", { name: "기록 일시 중지", exact: true })
    .click();
});

test("moves a live split workspace to another native window and back with scrollback intact", async () => {
  if (
    !(await page
      .getByRole("button", { name: "연결을 유지하며 이동", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "운영 도구", exact: true }).click();
  server.shells[0].write("\r\nBUFFER_BEFORE_WINDOW_MOVE\r\n");
  await expect(
    page.locator(`[data-pane-id="${paneA}"] .xterm-rows`),
  ).toContainText("BUFFER_BEFORE_WINDOW_MOVE");
  const oldWindow = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).windowId;
  const newWindow = application.waitForEvent("window");
  await page
    .getByRole("button", { name: "연결을 유지하며 이동", exact: true })
    .click();
  const second = await newWindow;
  second.on("pageerror", (e) => errors.push(e.message));
  await expect(second.locator(".terminal-pane")).toHaveCount(2);
  await expect(
    second.locator(`[data-pane-id="${paneA}"] .xterm-rows`),
  ).toContainText("BUFFER_BEFORE_WINDOW_MOVE");
  expect(server.shells.length).toBe(2);
  await expect(page.locator(".workspace-tab")).toHaveCount(0);
  // A delayed layout update from the source window must be harmless after ownership moves.
  await page.evaluate(async (id) => {
    await window.passport.call("session.resize", { id, cols: 77, rows: 17 });
    await window.passport.call("session.ack", { id, bytes: 1 });
  }, paneA);
  await expect(
    page.evaluate(
      (id) =>
        window.passport.call("session.input", { id, data: "wrong owner" }),
      paneA,
    ),
  ).rejects.toThrow("이 창");
  server.input.splice(0);
  await second
    .locator(`[data-pane-id="${paneA}"] .xterm-helper-textarea`)
    .focus();
  await second.keyboard.press("c");
  await expect.poll(() => server.input.join("")).toBe("c");
  await second.getByRole("button", { name: "운영 도구", exact: true }).click();
  await second.getByLabel("대상 앱 창").selectOption(String(oldWindow));
  await second
    .getByRole("button", { name: "연결을 유지하며 이동", exact: true })
    .click();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await expect(
    page.locator(`[data-pane-id="${paneA}"] .xterm-rows`),
  ).toContainText("BUFFER_BEFORE_WINDOW_MOVE");
  expect(server.shells.length).toBe(2);
  expect(errors).toEqual([]);
});

test("opens and keeps a local tab active when ownership events arrive after the save reply", async () => {
  const delayedEvents = await application.evaluateHandle(
    ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel === "passport:event" && args[0]?.kind === "document") {
          setTimeout(() => {
            if (!contents.isDestroyed()) send(channel, ...args);
          }, 250);
        } else send(channel, ...args);
      };
      return {
        restore: () => {
          contents.send = send;
        },
      };
    },
  );
  try {
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "1 / 1 연결",
    );
    await waitForLocalPrompt(page);
    await page.locator(".view:not([hidden]) .xterm-helper-textarea").focus();
    await page.keyboard.type(
      process.platform === "win32"
        ? "echo LOCAL_UI_OK"
        : "printf 'LOCAL_%s\\n' UI_OK",
    );
    await page.keyboard.press("Enter");
    await expect
      .poll(async () =>
        (
          await page
            .locator(".view:not([hidden]) .xterm-rows > div")
            .allTextContents()
        ).map((line) => line.trim()),
      )
      .toContain("LOCAL_UI_OK");
    expect(errors).toEqual([]);
  } finally {
    await delayedEvents.evaluate((e) => e.restore());
    await delayedEvents.dispose();
  }
});

test("saves custom colors and shortcuts and applies highlights without changing terminal text @desktop", async () => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "테마", exact: true }).click();
  await page
    .getByRole("button", { name: "현재 테마에서 만들기", exact: true })
    .click();
  await page.getByLabel("테마 이름", { exact: true }).fill("검증 테마");
  await page.getByLabel("색상 background", { exact: true }).fill("#112233");
  await page.getByRole("button", { name: "테마 저장", exact: true }).click();
  await expect(
    page.locator(".profile-row").filter({ hasText: "검증 테마" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "단축키", exact: true }).click();
  await page
    .getByRole("button", { name: "새 탭 · 로컬 터미널 키 1 변경", exact: true })
    .click();
  await page
    .getByLabel("키 조합", { exact: true })
    .press(process.platform === "darwin" ? "Meta+Shift+y" : "Control+Shift+y");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.getByRole("button", { name: "단축키 저장", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.settings.shortcuts[
          process.platform === "darwin" ? "darwin" : "win32"
        ].newTab,
    )
    .toEqual([process.platform === "darwin" ? "Meta+Shift+Y" : "Ctrl+Shift+Y"]);
  // The preceding window-transfer test leaves another native window focused.
  const windowId = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).windowId;
  await application.evaluate(({ app, BrowserWindow }, id) => {
    app.focus({ steal: true });
    BrowserWindow.fromId(id)?.focus();
  }, windowId);
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+y" : "Control+Shift+y",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".workspace-tab.active")).toContainText(
    "로컬 터미널",
  );
  await expect(
    page.locator(".view:not([hidden]) .xterm-helper-textarea"),
  ).toBeFocused();
  await page.locator(".workspace-tab").filter({ hasText: "후속 작업" }).click();
  await page
    .locator(`[data-pane-id="${paneA}"] .xterm-helper-textarea`)
    .focus();
  await page.getByRole("button", { name: "외형", exact: true }).click();
  await page.getByRole("button", { name: "검증 테마", exact: true }).click();
  await page.getByLabel("출력 강조", { exact: true }).selectOption("line");
  await page.getByLabel("IP · URL 함께 강조", { exact: true }).check();
  server.shells[0].write(
    "\x1b[2J\x1b[HERROR 한글 127.0.0.1\r\n\x1b[31mWARN ANSI_PRESERVED\x1b[0m\r\n",
  );
  const rows = page.locator(`[data-pane-id="${paneA}"] .xterm-rows`);
  await expect(rows).toContainText("ERROR 한글 127.0.0.1");
  await expect(
    page.locator(`[data-pane-id="${paneA}"] .xterm-decoration`),
  ).not.toHaveCount(0);
  const red = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).document.settings.customThemes[0].colors.red;
  const expectedRed = `rgb(${[1, 3, 5].map((i) => parseInt(red.slice(i, i + 2), 16)).join(", ")})`;
  const ansiColors = await rows
    .locator(":scope > div")
    .filter({ hasText: "WARN ANSI_PRESERVED" })
    .locator("span")
    .evaluateAll((nodes) =>
      nodes
        .filter((e) => e.textContent?.trim())
        .map((e) => getComputedStyle(e).color),
    );
  expect(ansiColors.length).toBeGreaterThan(0);
  expect([...new Set(ansiColors)]).toEqual([expectedRed]);
  await page.evaluate((id) => {
    (window as any).__originalHighlights = [
      ...document.querySelectorAll(`[data-pane-id="${id}"] .xterm-decoration`),
    ];
  }, paneA);
  for (let i = 0; i < 5; i++) {
    server.shells[0].write(`\x1b[4;1Hprogress ${i}`);
    await expect(rows).toContainText(`progress ${i}`);
  }
  expect(
    await page.evaluate(() =>
      (window as any).__originalHighlights.every((e: Element) => e.isConnected),
    ),
  ).toBe(true);
  server.shells[0].write("\x1b[?1049h\x1b[2J\x1b[HERROR ALTERNATE_SCREEN");
  await expect(rows).toContainText("ALTERNATE_SCREEN");
  await expect(
    page.locator(`[data-pane-id="${paneA}"] .xterm-decoration`),
  ).toHaveCount(0);
  server.shells[0].write("\x1b[?1049l");
  await page.getByLabel("출력 강조", { exact: true }).selectOption("none");
  await page.getByLabel("IP · URL 함께 강조", { exact: true }).uncheck();
  await expect(rows).toContainText("ERROR 한글 127.0.0.1");
  server.input.splice(0);
  await page
    .locator(`[data-pane-id="${paneA}"] .xterm-helper-textarea`)
    .focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    page.locator(`[data-pane-id="${paneB}"] .xterm-helper-textarea`),
  ).toBeFocused();
  await page.keyboard.press("z");
  await expect.poll(() => server.input.join("")).toBe("z");
  expect(errors).toEqual([]);
});

test("bulk host edits change only checked fields", async () => {
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page.getByLabel("후속 검증 일괄 선택", { exact: true }).check();
  await page
    .getByRole("button", { name: "일괄 편집 · 1", exact: true })
    .click();
  await page.getByLabel("태그 교체", { exact: true }).check();
  await page.getByLabel("일괄 태그", { exact: true }).fill("운영, 테스트");
  await page
    .getByRole("dialog")
    .screenshot({ path: test.info().outputPath("bulk-spacing.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "선택 항목 적용", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.hosts[0].tags,
    )
    .toEqual(["운영", "테스트"]);
  const host = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).document.hosts[0];
  expect(host.port).toBe(server.port);
  expect(host.username).toBe("tester");
});

test("500-host list and expanded host settings scroll independently inside a small window", async () => {
  const windowId = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).windowId;
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.setSize(1024, 680),
    windowId,
  );
  await page.evaluate(async () => {
    const b = await window.passport.call("bootstrap", undefined),
      host = b.document.hosts[0];
    b.document.hosts = [
      host,
      ...Array.from({ length: 499 }, (_, i) => ({
        ...host,
        id: crypto.randomUUID(),
        name: `목록 ${String(i).padStart(3, "0")}`,
      })),
    ];
    await window.passport.call("save", b.document);
  });
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page.locator(".host-row").first().click();
  await page
    .locator(".host-detail summary")
    .filter({ hasText: "상속" })
    .click();
  const list = page.locator(".host-list"),
    detail = page.locator(".host-detail");
  await expect(page.locator(".host-row")).toHaveCount(500);
  const bounds = await page.evaluate(() => {
    const status = document
      .querySelector(".app-status")!
      .getBoundingClientRect().top;
    return [".host-list", ".host-detail"].map((selector) => {
      const e = document.querySelector(selector)!;
      return {
        bottom: e.getBoundingClientRect().bottom,
        status,
        scroll: e.scrollHeight,
        client: e.clientHeight,
      };
    });
  });
  for (const b of bounds) {
    expect(b.bottom).toBeLessThanOrEqual(b.status + 1);
    expect(b.scroll).toBeGreaterThan(b.client);
  }
  await detail.hover();
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() => detail.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "호스트 저장", exact: true }),
  ).toBeInViewport();
  const position = await detail.evaluate((e) => e.scrollTop);
  await list.hover();
  await page.mouse.wheel(0, 100000);
  await expect
    .poll(() => list.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(1000);
  expect(await detail.evaluate((e) => e.scrollTop)).toBe(position);
  await expect(page.locator(".bulk-toolbar")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("host-scroll.png") });
});
