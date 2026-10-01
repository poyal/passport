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
import { emptyDocument, hostSchema } from "../../src/shared/model";
import { encodePortable, decodePortable } from "../../src/main/portable";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";

let application: ElectronApplication, page: Page, directory: string;
let server: Awaited<ReturnType<typeof sshFixture>>;
const hostId = randomUUID(),
  paneId = randomUUID(),
  workspaceId = randomUUID(),
  profileId = randomUUID();
const password = "test-only-export-password";
const errors: string[] = [];
const portable = {
  format: "passport" as const,
  version: 2 as const,
  document: emptyDocument(),
  profiles: [],
};
portable.document.hosts = [
  hostSchema.parse({
    id: randomUUID(),
    name: "가져오기 테스트",
    address: "example.test",
    username: "tester",
  }),
];
const pick = async (file: string) =>
  application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
const settings = async (section: string) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: section, exact: true })
    .click();
};

test.beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-settings-tools-"),
  );
  server = await sshFixture(directory);
  application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  page = await application.firstWindow();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".hosts-view")).toBeVisible();
  await application.evaluate(({ safeStorage, dialog, shell }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (text) => Buffer.from(text);
    safeStorage.decryptString = (buffer) => buffer.toString();
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
    const state = globalThis as unknown as { opened: string[] };
    state.opened = [];
    shell.openExternal = async (url) => {
      state.opened.push(url);
    };
  });
  const host = hostSchema.parse({
    id: hostId,
    name: "검색 테스트",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
  });
  await page.evaluate(
    async ({ host, paneId, workspaceId, profileId }) => {
      await window.passport.call("auth.save", {
        id: profileId,
        name: "Fixture credentials",
        username: "tester",
        secret: {
          type: "password",
          password: "test-only-secret",
          privateKey: "",
          passphrase: "",
        },
      });
      const { document } = await window.passport.call("bootstrap", undefined);
      document.hosts = [host];
      document.workspaces = [
        {
          id: workspaceId,
          name: "검색 작업",
          root: { kind: "pane", id: paneId, hostId: host.id },
        },
      ];
      await window.passport.call("save", document);
    },
    { host, paneId, workspaceId, profileId },
  );
  await page.locator(".workspace-tab").click();
  await page.evaluate(
    async ({ paneId, hostId }) =>
      window.passport.call("session.connect", {
        id: paneId,
        hostId,
        secret: {
          type: "password",
          password: "test-only-password",
          privateKey: "",
          passphrase: "",
        },
      }),
    { paneId, hostId },
  );
  await expect(page.locator(".terminal-pane .dot.connected")).toBeVisible();
});
test.afterAll(async () => {
  try {
    if (application) await closeCleanly(application);
  } finally {
    await server?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

test("export explains short passwords and writes decryptable credentials once the minimum is met", async () => {
  const file = path.join(directory, "export.json");
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await settings("내보내기와 백업");
  await page.getByRole("tab", { name: "내보내기", exact: true }).click();
  await page.getByLabel("비밀번호와 개인 키 포함").check();
  const input = page.getByLabel("내보내기 암호", { exact: true });
  await input.fill("123456789");
  await expect(
    page.getByRole("button", { name: "내보내기", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#export-password-help")).toContainText("현재 9자");
  await input.fill(password);
  await expect(
    page.getByRole("button", { name: "내보내기", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  await expect
    .poll(async () => fs.readFile(file, "utf8").catch(() => ""))
    .toContain("passport-encrypted");
  const exported = await fs.readFile(file, "utf8");
  expect(exported).not.toContain("test-only-secret");
  expect(
    (await decodePortable(exported, password)).secrets?.[profileId].password,
  ).toBe("test-only-secret");
});

test("imports ask after file selection, allow password retry, cancel tickets, and bypass the prompt for plain files", async ({}, info) => {
  const encrypted = path.join(directory, "encrypted.json"),
    plain = path.join(directory, "plain.json");
  await fs.writeFile(encrypted, await encodePortable(portable, password));
  await fs.writeFile(plain, await encodePortable(portable));
  await page.getByRole("tab", { name: "가져오기", exact: true }).click();
  await expect(page.getByLabel("파일 암호", { exact: true })).toHaveCount(0);
  await pick(encrypted);
  await page.getByRole("button", { name: "파일 선택 · 미리보기" }).click();
  const dialog = page.getByRole("dialog", { name: "파일 암호 입력" });
  await expect(dialog).toContainText("encrypted.json");
  await expect(dialog.getByLabel("파일 암호", { exact: true })).toBeFocused();
  await fs.rm(encrypted); // Retries use the already selected encrypted file.
  await dialog.getByLabel("파일 암호", { exact: true }).fill("wrong");
  await dialog.getByRole("button", { name: "암호 확인 · 미리보기" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "암호가 다르거나 파일이 손상",
  );
  await page.screenshot({
    path: info.outputPath("import-password-retry.png"),
    animations: "disabled",
  });
  await dialog.getByLabel("파일 암호", { exact: true }).fill(password);
  await dialog.getByLabel("파일 암호", { exact: true }).press("Enter");
  await expect(
    page.getByRole("button", { name: "가져오기 적용" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("가져오기 테스트");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await fs.writeFile(encrypted, await encodePortable(portable, password));
  await pick(encrypted);
  const request = await page.evaluate(async () =>
    window.passport.call("data.preview", { kind: "passport" }),
  );
  expect(request && "needsPassword" in request).toBe(true);
  if (request && "needsPassword" in request) {
    const error = await page.evaluate(
      async ({ token, password }) => {
        await window.passport.call("data.cancel", { token });
        try {
          await window.passport.call("data.unlock", { token, password });
          return "accepted";
        } catch (error) {
          return String(error);
        }
      },
      { token: request.token, password },
    );
    expect(error).toContain("만료");
  }
  await pick(plain);
  await page.getByRole("button", { name: "파일 선택 · 미리보기" }).click();
  await expect(
    page.getByRole("button", { name: "가져오기 적용" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "파일 암호 입력" }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
});

test("settings use accessible switches, merge themes, and expose only the confirmed About links", async ({}, info) => {
  await settings("외형");
  await page.getByRole("tab", { name: "터미널 설정" }).click();
  const toggle = page.getByRole("switch", { name: "파일·폴더 색상 구분" });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("switch")).toHaveCount(3);
  await page.screenshot({
    path: info.outputPath("terminal-switches.png"),
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "테마", exact: true }).click();
  await expect(page.getByRole("tab", { name: "사용자 테마" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "사용자 색상 테마", exact: true }),
  ).toBeVisible();
  await settings("About");
  await expect(page.locator(".about-card dl")).toContainText("Poyal");
  await expect(page.locator(".about-card dl")).toContainText(
    "poyal.work@gmail.com",
  );
  for (const name of [
    "GitHub",
    "버그 신고 · 기능 제안",
    "새 버전 다운로드",
    "이메일 문의",
  ])
    await page
      .locator(".about-links")
      .getByRole("link", { name, exact: true })
      .click();
  const opened = await application.evaluate(
    () => (globalThis as unknown as { opened: string[] }).opened,
  );
  expect(opened).toEqual([
    "https://github.com/poyal/passport",
    "https://github.com/poyal/passport/issues",
    "https://github.com/poyal/passport/releases",
    "mailto:poyal.work@gmail.com",
  ]);
  await page.screenshot({
    path: info.outputPath("about.png"),
    animations: "disabled",
  });
});

test("log viewer removes terminal controls and hyperlinks while the original export stays intact", async ({}, info) => {
  server.shells[0].write(
    "\r\n\x1b[?2026h\x1b[31mLOG_CLEAN_한글\x1b[0m\x1b]8;;https://example.test\x1b\\링크\x1b]8;;\x1b\\\x1b[?2026l\r\n",
  );
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const [log] = await window.passport.call("logs.list", undefined);
        return (await window.passport.call("logs.read", { id: log.id })).text;
      }),
    )
    .toContain("LOG_CLEAN_한글");
  await settings("세션 로그");
  await page.locator(".log-list button").first().click();
  await expect(page.locator(".log-reader pre")).toContainText(
    "LOG_CLEAN_한글링크",
  );
  await expect(page.locator(".log-reader pre")).not.toContainText("[?2026h");
  await expect(page.locator(".log-reader pre")).not.toContainText(
    "https://example.test",
  );
  await page.getByLabel("로그 검색").fill("LOG_CLEAN_한글링크");
  await page
    .locator(".log-reader")
    .getByRole("button", { name: "검색", exact: true })
    .click();
  await expect(page.locator(".log-reader pre")).toContainText(
    "LOG_CLEAN_한글링크",
  );
  await page.screenshot({
    path: info.outputPath("clean-log.png"),
    animations: "disabled",
  });
  const file = path.join(directory, "original.log");
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page
    .locator(".log-reader")
    .getByRole("button", { name: "내보내기", exact: true })
    .click();
  await expect
    .poll(async () => fs.readFile(file, "utf8").catch(() => ""))
    .toContain("\x1b[?2026h");
});

test("terminal search counts matches, scrolls on Enter, wraps, highlights, and consumes no terminal input", async ({}, info) => {
  await page.locator(".workspace-tab").click();
  const pane = page.locator(`[data-pane-id="${paneId}"]`);
  server.shells[0].write(
    "\x1b[2J\x1b[H" +
      Array.from({ length: 400 }, (_, i) =>
        i % 40 === 0
          ? `SEARCH_TARGET_${String(i / 40 + 1).padStart(2, "0")} 한글\r\n`
          : `line ${i}\r\n`,
      ).join(""),
  );
  await expect(pane.locator(".xterm-rows")).toContainText("line 399");
  await pane.getByRole("button", { name: "터미널 검색", exact: true }).click();
  const input = pane.getByLabel("터미널 출력 검색");
  await input.fill("SEARCH_TARGET");
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "1/10",
  );
  await expect(pane.locator(".xterm-rows")).toContainText("SEARCH_TARGET_01");
  await input.press("Enter");
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "2/10",
  );
  await expect(pane.locator(".xterm-rows")).toContainText("SEARCH_TARGET_02");
  await input.press("Shift+Enter");
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "1/10",
  );
  await input.press("Shift+Enter");
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "10/10",
  );
  await expect(
    pane.locator(".xterm-find-result-decoration:visible").first(),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("search-matches.png"),
    animations: "disabled",
  });
  const decoration = await pane
    .locator(".xterm-find-result-decoration:visible")
    .first()
    .evaluate((el) => ({
      border: getComputedStyle(el).outlineStyle,
      outline: getComputedStyle(el).outlineWidth,
    }));
  // xterm paints decoration backgrounds in the terminal renderer, not this DOM overlay.
  expect(decoration.border).toBe("solid");
  expect(decoration.outline).toBe("2px");
  const previousColor = await pane
    .locator(".xterm-find-result-decoration:visible")
    .first()
    .evaluate((el) => getComputedStyle(el).outlineColor);
  await page.evaluate(async () => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.settings.appearance.theme = "nord";
    await window.passport.call("save", document);
  });
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "10/10",
  );
  await expect
    .poll(async () =>
      pane
        .locator(".xterm-find-result-decoration:visible")
        .first()
        .evaluate((el) => getComputedStyle(el).outlineColor),
    )
    .not.toBe(previousColor);
  server.shells[0].write("SEARCH_TARGET_11 한글\r\n");
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "10/11",
  );
  server.input.splice(0);
  await input.fill("NO_SUCH_MATCH");
  await expect(pane.getByRole("status", { name: "검색 결과" })).toHaveText(
    "0/0",
  );
  await expect(
    pane.getByRole("button", { name: "다음 검색 결과" }),
  ).toBeDisabled();
  await input.press("Enter");
  await input.press("Escape");
  await expect(pane.locator(".terminal-search")).toHaveCount(0);
  expect(server.input).toEqual([]);
  expect(errors).toEqual([]);
});
