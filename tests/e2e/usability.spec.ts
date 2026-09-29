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
import { hostSchema, type Host } from "../../src/shared/model";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";
let application: ElectronApplication,
  page: Page,
  directory: string,
  server: Awaited<ReturnType<typeof sshFixture>>;
let hosts: Host[];
const errors: string[] = [];
const authId = randomUUID(),
  groupId = randomUUID();
test.beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-usability-"));
  await fs.mkdir(path.join(directory, "remote", "root"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "remote", "root", "example.txt"),
    "example\n",
  );
  server = await sshFixture(path.join(directory, "remote"));
  application = await electron.launch({
    args: ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".hosts-view")).toBeVisible();
  await application.evaluate(({ dialog, safeStorage }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
    // Isolated fixture credentials do not access the user's operating-system keychain.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (text) => Buffer.from(text);
    safeStorage.decryptString = (buffer) => buffer.toString();
  });
  hosts = Array.from({ length: 63 }, (_, i) =>
    hostSchema.parse({
      id: randomUUID(),
      name: `예제 서버 ${String(i + 1).padStart(2, "0")}`,
      address: "127.0.0.1",
      port: server.port,
      username: "old-account",
      detectedOS: [
        undefined,
        "CentOS release 5.11 (Final)",
        "Red Hat Enterprise Linux 8.10",
        "Rocky Linux 9.5",
        "Ubuntu 24.04.4 LTS",
        "Microsoft Windows Server 2025",
        "Debian GNU/Linux 12",
        "Fedora Linux 42",
        "Darwin",
      ][i],
      authId,
      groupId,
      startPath: "/root",
      tags: ["Test"],
    }),
  );
  await page.evaluate(
    async ({ hosts, authId, groupId }) => {
      await window.passport.call("auth.save", {
        id: authId,
        name: "테스트 계정",
        username: "tester",
        secret: {
          type: "password",
          password: "test-only-password",
          privateKey: "",
          passphrase: "",
        },
      });
      const { document } = await window.passport.call("bootstrap", undefined);
      document.hosts = hosts;
      document.groups = [
        { id: groupId, name: "테스트", parentId: null, defaults: {} },
      ];
      await window.passport.call("save", document);
    },
    { hosts, authId, groupId },
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

test("new hosts start empty, saved credentials collapse account fields, and group edits live in settings", async ({}, info) => {
  await page.getByRole("button", { name: "새 호스트", exact: true }).click();
  for (const name of ["이름", "서버 주소", "사용자 이름", "포트"])
    await expect(page.getByLabel(name, { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "저장된 인증 선택", exact: true })
    .click();
  await page.getByLabel("인증 검색").fill("tester");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /테스트 계정/ })
    .click();
  await expect(page.getByLabel("사용자 이름", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "저장된 인증 변경" }),
  ).toContainText("tester");
  await page.screenshot({
    path: info.outputPath("saved-credentials.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "저장된 인증 변경" }).click();
  await page.screenshot({
    path: info.outputPath("credential-picker.png"),
    animations: "disabled",
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /직접 입력/ })
    .click();
  await expect(page.getByLabel("사용자 이름", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("");
  await expect(page.locator(".group-actions")).toHaveCount(0);
  await page.getByRole("button", { name: "그룹 관리 설정" }).click();
  await expect(
    page.getByRole("heading", { name: "그룹 관리", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "테스트 이름 변경" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("검증 그룹");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "적용", exact: true })
    .click();
  await expect(page.locator(".group-settings-list")).toContainText("검증 그룹");
});

test("SFTP parent row reaches root with one click, file errors alert, and host pickers stay bounded", async () => {
  await page.getByRole("button", { name: "파일", exact: true }).click();
  await page.getByRole("button", { name: "오른쪽 연결", exact: true }).click();
  await expect(page.locator(".host-picker-list .host-choice")).toHaveCount(64);
  const height = await page.locator(".host-picker-list").evaluate((el) => ({
    height: el.clientHeight,
    scroll: el.scrollHeight,
    viewport: innerHeight,
  }));
  expect(height.height).toBeLessThan(height.viewport * 0.6);
  expect(height.scroll).toBeGreaterThan(height.height);
  await page.getByLabel("연결할 호스트 검색").fill("예제 서버 01");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /예제 서버 01/ })
    .click();
  await expect(page.getByLabel("오른쪽 경로", { exact: true })).toHaveValue(
    "/root",
  );
  await page
    .locator(".file-panel")
    .last()
    .locator(".parent-row td")
    .click({ position: { x: 300, y: 15 } });
  await expect(page.getByLabel("오른쪽 경로", { exact: true })).toHaveValue(
    "/",
  );
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.hosts[0].detectedOS,
    )
    .toBe("Alpine Linux 3.22");
  await page
    .getByLabel("오른쪽 경로", { exact: true })
    .fill("/missing-directory");
  await page.getByLabel("오른쪽 경로", { exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "알림 닫기" }).click();
  await page
    .locator(".file-panel")
    .last()
    .getByRole("button", { name: "새로고침", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toHaveText("새로고침");
});

test("profile account connects, paste is immediate and literal, automatic logs capture output and auth failures alert", async () => {
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page
    .locator(".host-row")
    .filter({ hasText: "예제 서버 01" })
    .dblclick();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  await expect.poll(() => server.shells.length).toBe(1);
  const pane = await page
    .locator(".terminal-pane")
    .getAttribute("data-pane-id");
  await page.evaluate(() =>
    window.passport.call("clipboard.write", { text: "echo {{literal}}\n" }),
  );
  server.input.splice(0);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+Shift+v",
  );
  await expect
    .poll(() => server.input.join(""))
    .toBe("\x1b[200~echo {{literal}}\x1b[201~");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const logs = await page.evaluate(() =>
    window.passport.call("logs.list", undefined),
  );
  expect(logs.some((l) => l.recording)).toBe(true);
  await page.getByRole("button", { name: "운영 도구", exact: true }).click();
  const widths = await page.locator(".toolbox").evaluate((el) => ({
    input: el.querySelector("input")!.getBoundingClientRect().width,
    textarea: el.querySelector("textarea")!.getBoundingClientRect().width,
  }));
  expect(Math.abs(widths.input - widths.textarea)).toBeLessThan(2);
  await page.getByRole("button", { name: "도구 패널 닫기" }).click();
  await page.getByRole("button", { name: "터미널 분할", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "터미널 분할" })).toBeVisible();
  await page.getByLabel("연결할 호스트 검색").fill("예제 서버 63");
  await expect(page.locator(".host-choice")).toHaveCount(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.evaluate(
    async ({ pane, hostId }) => {
      await window.passport.call("session.connect", {
        id: pane!,
        hostId,
        secret: {
          type: "password",
          password: "invalid",
          privateKey: "",
          passphrase: "",
        },
      });
    },
    { pane, hostId: hosts[0].id },
  );
  await expect(page.getByRole("alert")).toContainText(
    /authentication|인증|실패/i,
  );
  await page.getByRole("button", { name: "알림 닫기" }).click();
});

test("all main screens fit light and dark themes at desktop and minimum window sizes", async ({}, info) => {
  for (const [width, height] of [
    [1440, 900],
    [1024, 680],
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    for (const mode of ["dark", "light"] as const) {
      await page.evaluate(async (mode) => {
        const { document } = await window.passport.call("bootstrap", undefined);
        document.settings.colorMode = mode;
        await window.passport.call("save", document);
      }, mode);
      await page.getByRole("button", { name: "호스트", exact: true }).click();
      await page.locator(".host-row").first().click();
      await page.mouse.move(800, 20);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`hosts-${mode}-${width}.png`),
      });
      await page.getByRole("button", { name: "파일", exact: true }).click();
      await page.mouse.move(800, 20);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`files-${mode}-${width}.png`),
      });
      await page.getByRole("button", { name: "설정", exact: true }).click();
      for (const section of [
        "외형",
        "그룹 관리",
        "인증 프로필",
        "세션 로그",
        "포트 포워딩",
        "내보내기와 백업",
        "단축키",
      ]) {
        await page
          .locator(".settings-sidebar")
          .getByRole("button", { name: section, exact: true })
          .click();
        await page.locator(".settings-content").evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.mouse.move(800, 20);
        await page.screenshot({
          animations: "disabled",
          path: info.outputPath(`${section}-${mode}-${width}.png`),
        });
        expect(
          await page
            .locator(".settings-content")
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          section,
        ).toBe(true);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "세션 로그", exact: true })
    .click();
  await page.getByLabel("보관 일수", { exact: true }).fill("7");
  await page.getByLabel("보관 일수", { exact: true }).press("Tab");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.settings.logRetentionDays,
    )
    .toBe(7);
  expect(errors).toEqual([]);
});

test("direct passwords become reusable protected profiles instead of host metadata", async () => {
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page.getByRole("button", { name: "새 호스트", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill("직접 인증 예제");
  await page.getByLabel("서버 주소", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("사용자 이름", { exact: true }).fill("tester");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("private-ui-fixture-password");
  await page.getByRole("button", { name: "호스트 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "저장된 인증 변경" }),
  ).toContainText("직접 인증 예제 인증");
  const saved = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  const host = saved.document.hosts.find((h) => h.name === "직접 인증 예제")!;
  expect(host.port).toBe(22);
  expect(saved.profiles.find((p) => p.id === host.authId)).toMatchObject({
    username: "tester",
    hasSecret: true,
  });
  expect(JSON.stringify(saved)).not.toContain("private-ui-fixture-password");
  await page.getByRole("button", { name: "저장된 인증 변경" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /직접 입력/ })
    .click();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});
