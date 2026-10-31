import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { electron } from "../../scripts/e2e-electron.mjs";
import { closeCleanly } from "../fixtures/electron-exit";
import { cliCoordinator } from "../fixtures/cli-coordinator";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// These tests own two independent app profiles and live transfers. ShareStore,
// encrypted identity and network listeners are outside reusableApp's reset.
let root: string;
const apps: ElectronApplication[] = [];
const errors: string[] = [];
test.beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "passport-share-e2e-")),
  );
  // Electron requires this known folder when USERPROFILE is isolated on Windows.
  await fs.mkdir(path.join(root, "Downloads"));
  errors.length = 0;
});
test.afterEach(async () => {
  try {
    for (const app of apps.splice(0).reverse()) {
      await app.evaluate(({ safeStorage, clipboard, dialog, shell }) => {
        const original = (globalThis as any).__shareOriginal;
        if (!original) return;
        Object.assign(safeStorage, original.safeStorage);
        clipboard.writeText = original.writeText;
        dialog.showOpenDialog = original.showOpenDialog;
        shell.openPath = original.openPath;
        delete (globalThis as any).__shareOriginal;
        delete (globalThis as any).__shareCopied;
        delete (globalThis as any).__shareOpened;
      });
      await closeCleanly(app);
    }
    expect(errors).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
const snapshot = (page: Page) =>
  page.evaluate(() => window.passport.call("share.state", undefined));
async function selectPending(page: Page) {
  await page.locator(".share-message-list button.pending").first().click();
}
async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate(async (theme) => {
    const boot = await window.passport.call("bootstrap", undefined);
    boot.document.settings.colorMode = theme;
    await window.passport.call("save", boot.document);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function launch(name: string) {
  const app = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: path.join(root, name),
      HOME: root,
      USERPROFILE: root,
    },
    timeout: 30000,
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ safeStorage, clipboard, dialog, shell }) => {
    const crypto = process.getBuiltinModule("node:crypto"),
      key = crypto.randomBytes(32);
    (globalThis as any).__shareOriginal = {
      safeStorage: {
        isEncryptionAvailable: safeStorage.isEncryptionAvailable,
        encryptString: safeStorage.encryptString,
        decryptString: safeStorage.decryptString,
      },
      writeText: clipboard.writeText,
      showOpenDialog: dialog.showOpenDialog,
      openPath: shell.openPath,
    };
    // Test-owned encryption avoids prompting for the user's Keychain. The
    // actual network, file protection, IPC and renderer remain unmocked.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (text) => {
      const nonce = crypto.randomBytes(12),
        cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([
        nonce,
        cipher.update(text),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    };
    safeStorage.decryptString = (bytes) => {
      const cipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        cipher.update(bytes.subarray(12, -16)),
        cipher.final(),
      ]).toString();
    };
    clipboard.writeText = async (text) => {
      (globalThis as any).__shareCopied = text;
    };
    (globalThis as any).__shareOpened = [];
    shell.openPath = async (file) => {
      (globalThis as any).__shareOpened.push(file);
      return "";
    };
  });
  await page.locator('.app-tab[aria-label="쪽지"]').click();
  const directory = path.join(root, name, "downloads");
  await page.evaluate(
    async ({ name, directory }) => {
      const current = await window.passport.call("share.state", undefined);
      await window.passport.call("share.configure", {
        ...current.settings,
        receiveDirectory: directory,
        name,
      });
    },
    { name, directory },
  );
  await page.getByRole("button", { name: "쪽지 설정", exact: true }).click();
  await expect(page.getByLabel("내 표시 이름", { exact: true })).toHaveCount(0);
  const apply = page.getByRole("button", { name: "쪽지 설정 적용" });
  await expect(apply).toBeDisabled();
  await page.getByLabel("쪽지 사용", { exact: true }).check();
  await expect(apply).toBeDisabled();
  await page.getByLabel("사용할 네트워크").selectOption("127.0.0.1");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect
    .poll(async () => (await snapshot(page)).endpoint?.address)
    .toBe("127.0.0.1");
  await expect(apply).toBeDisabled();
  await page.getByLabel("쪽지 자동 정리").selectOption("30");
  await expect(apply).toBeEnabled();
  await page.getByLabel("쪽지 자동 정리").selectOption("7");
  await expect(apply).toBeDisabled();
  return { app, page, directory };
}
async function pair() {
  const a = await launch("승민"),
    b = await launch("지수");
  await b.page.locator('.app-tab[aria-label="쪽지"]').click();
  await b.page
    .getByRole("button", { name: "등록키 복사", exact: true })
    .click();
  await expect
    .poll(() => b.app.evaluate(() => (globalThis as any).__shareCopied))
    .toMatch(/^passport-pair:/);
  const key = await b.app.evaluate(
    () => (globalThis as any).__shareCopied as string,
  );
  await a.page.getByLabel("상대 별칭", { exact: true }).fill("지수");
  await a.page.getByLabel("상대에게 받은 등록키", { exact: true }).fill(key);
  await a.page.getByRole("button", { name: "등록 요청 보내기" }).click();
  await b.page.locator('.app-tab[aria-label="쪽지"]').click();
  await expect(
    b.page.getByRole("button", { name: "사용자 등록 승인" }),
  ).toBeVisible();
  expect((await snapshot(a.page)).peers).toEqual([]);
  await expect(
    b.page.getByRole("button", { name: "사용자 등록 승인" }),
  ).toBeDisabled();
  await b.page
    .locator(".sharing-view")
    .getByLabel("상대 별칭", { exact: true })
    .fill("승민");
  await b.page.getByRole("button", { name: "사용자 등록 승인" }).click();
  await expect.poll(async () => (await snapshot(a.page)).peers.length).toBe(1);
  await a.page.locator('.app-tab[aria-label="쪽지"]').click();
  await expect(
    a.page.getByRole("tab", { name: "받은 쪽지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await a.page.getByRole("tab", { name: /내 친구/ }).click();
  await expect(a.page.locator(".share-friends .share-peer strong")).toHaveText(
    "지수",
  );
  await a.page
    .getByRole("button", { name: "지수에게 보내기", exact: true })
    .click();
  await expect(
    a.page.getByRole("tab", { name: "보내기", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    a.page.getByRole("combobox", { name: "받는 사람", exact: true }),
  ).toHaveValue("지수");
  await a.page
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  return { a, b };
}

test("validates notes settings, guide copying, message drafts and inbox, sending and friends controls", async () => {
  const { app, page, directory } = await launch("sharing-ui");
  const apply = page.getByRole("button", { name: "쪽지 설정 적용" });
  await page.getByLabel("쪽지 자동 정리").selectOption("30");
  await apply.click();
  await expect(apply).toBeDisabled();
  expect((await snapshot(page)).settings.retentionDays).toBe(30);
  await page.getByLabel("사용할 네트워크").selectOption("");
  await expect(apply).toBeDisabled();
  // A missing network must never prevent turning sharing off.
  await page.getByLabel("쪽지 사용", { exact: true }).uncheck();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(apply).toBeDisabled();
  await page.locator('.app-tab[aria-label="쪽지"]').click();
  await expect(
    page.getByRole("button", { name: "등록키 복사", exact: true }),
  ).toBeDisabled();
  await page.evaluate(async () => {
    const state = await window.passport.call("share.state", undefined);
    await window.passport.call("share.configure", {
      ...state.settings,
      receiveDirectory: "",
    });
  });
  await page.getByRole("button", { name: "쪽지 설정", exact: true }).click();
  await page.getByLabel("쪽지 사용", { exact: true }).check();
  await page.getByLabel("사용할 네트워크").selectOption("127.0.0.1");
  await expect(apply).toBeDisabled();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, directory);
  await page.getByRole("button", { name: "폴더 선택", exact: true }).click();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(apply).toBeDisabled();

  for (const width of [1000, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const controls = page.locator(".share-actions").filter({
        has: page.getByRole("button", { name: "쪽지 기기키 초기화" }),
      });
      await controls.scrollIntoViewIfNeeded();
      const buttons = await controls.locator("button").evaluateAll((buttons) =>
        buttons.map((b) => {
          const { x, y, width, height } = b.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
      const [a, b] = buttons;
      expect(
        Math.abs(a.y - b.y) < 1 ? b.x - a.x - a.width : b.y - a.y - a.height,
      ).toBeGreaterThanOrEqual(8);
      await page.screenshot({
        path: test.info().outputPath(`sharing-settings-${theme}-${width}.png`),
      });
    }
  }
  await page.locator('.app-tab[aria-label="쪽지"]').click();
  await expect(
    page.getByRole("tab", { name: "받은 쪽지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Markdown 쪽지", exact: true }),
  ).toHaveCount(0);
  for (const width of [1000, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const alignment = await page
        .locator(".share-section-heading")
        .evaluate((el) => {
          const title = el.querySelector("h2")!.getBoundingClientRect();
          const button = el.querySelector("button")!.getBoundingClientRect();
          return Math.abs(
            title.y + title.height / 2 - button.y - button.height / 2,
          );
        });
      expect(alignment).toBeLessThanOrEqual(1);
      expect(
        await page
          .locator(".sharing-view")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: test.info().outputPath(`sharing-inbox-${theme}-${width}.png`),
      });
    }
  }
  await page.getByRole("button", { name: "등록키 복사", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).__shareCopied))
    .toMatch(/^passport-pair:/);
  await page.getByRole("button", { name: "사용가이드", exact: true }).click();
  const guide = page.getByRole("dialog", { name: "사용가이드" });
  await expect(
    guide.getByRole("heading", { name: "1. 같은 네트워크에서 친구 등록" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      guide
        .locator("img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  await guide
    .getByRole("button", { name: "Passport CLI", exact: true })
    .click();
  await guide
    .getByRole("button", { name: "쪽지 명령 복사", exact: true })
    .click();
  expect(await app.evaluate(() => (globalThis as any).__shareCopied)).toContain(
    "passport share status",
  );
  await guide
    .getByRole("button", { name: "AI에게 전달하기", exact: true })
    .click();
  await guide
    .getByRole("button", { name: "AI 안내문 복사", exact: true })
    .click();
  const copiedGuide = await app.evaluate(
    () => (globalThis as any).__shareCopied,
  );
  expect(copiedGuide).toContain("delivered에서만 전달 완료");
  expect(copiedGuide).toContain("--markdown-file");
  expect(copiedGuide).toContain("passport identify");
  expect(copiedGuide).not.toContain("passport-pair:");
  await page.keyboard.press("Escape");
  await expect(guide).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "사용가이드", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "등록키 복사", exact: true }).click();
  const key = await app.evaluate(() => (globalThis as any).__shareCopied);
  await page.getByRole("button", { name: "등록키 복사", exact: true }).click();
  expect(await app.evaluate(() => (globalThis as any).__shareCopied)).toBe(key);
  await page.getByRole("tab", { name: "보내기", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "쪽지", exact: true });
  await editor.fill("작업 결과");
  await page.getByRole("button", { name: "제목", exact: true }).click();
  await expect(page.locator(".tiptap h1")).toHaveText("작업 결과");
  await page
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 쪽지", exact: true }),
  ).toHaveValue(/^# 작업 결과\s*$/);
  await page.getByRole("button", { name: "서식 편집", exact: true }).click();
  await expect(page.locator(".tiptap h1")).toHaveText("작업 결과");
  await page
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 쪽지", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "보관 쪽지 불러오기" }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Markdown 쪽지", exact: true })
    .fill("보내기 초안");
  await page.locator('.app-tab[aria-label="쪽지"]').click();
  await expect(
    page.getByRole("tab", { name: "받은 쪽지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "보내기", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 쪽지", exact: true }),
  ).toHaveValue("보내기 초안");
  await page.getByRole("tab", { name: /내 친구/ }).click();
  await expect(page.locator(".share-friends")).toContainText(
    "아직 등록된 친구가 없습니다.",
  );
  await page.getByRole("button", { name: "친구 목록 불러오기" }).click();
  await page.getByRole("tab", { name: /내 친구/ }).focus();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "받은 쪽지", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "받은 쪽지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("pairs two devices, sends messages with optional attachments after one approval and renders inert content", async () => {
  const { a, b } = await pair();
  const network: string[] = [];
  b.page.on("request", (req) => {
    if (req.url().includes("share-example.invalid")) network.push(req.url());
  });
  const text =
    '# 작업 결과\n\n[외부 링크](https://share-example.invalid/)\n\n![외부 이미지](https://share-example.invalid/pixel.png)\n\n<script>window.__shareExecuted=true</script>\n\n<iframe src="https://share-example.invalid/"></iframe>\n\n```sh\necho hello\n```';
  await a.page
    .getByRole("combobox", { name: "받는 사람", exact: true })
    .fill("지수");
  await a.page.getByRole("option", { name: /지수/ }).click();
  await a.page
    .getByRole("textbox", { name: "Markdown 쪽지", exact: true })
    .fill(text);
  await a.page
    .getByRole("button", { name: "쪽지 보내기", exact: true })
    .click();
  await selectPending(b.page);
  await expect(
    b.page.getByRole("button", { name: "쪽지 받기", exact: true }),
  ).toBeVisible();
  expect((await snapshot(b.page)).messages).toEqual([]);
  await b.page
    .getByRole("group", { name: "쪽지 처리 상태" })
    .getByRole("button", { name: "받은 쪽지", exact: true })
    .click();
  await expect(b.page.locator(".share-message-list button")).toHaveCount(0);
  await b.page
    .getByRole("group", { name: "쪽지 처리 상태" })
    .getByRole("button", { name: /승인 대기/ })
    .click();
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
  await expect(b.page.locator(".share-markdown")).toHaveCount(0);

  await selectPending(b.page);
  await b.page.getByRole("button", { name: "쪽지 받기", exact: true }).click();
  await expect(
    b.page.locator(".share-message-list button.pending"),
  ).toHaveCount(0);
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
  await expect(
    b.page.getByRole("status").filter({ hasText: "쪽지를 받았습니다." }),
  ).toBeVisible();
  await expect(
    a.page.getByRole("status").filter({ hasText: "상대에게 전달했습니다." }),
  ).toBeVisible();
  await expect(b.page.locator(".toast.error")).toHaveCount(0);
  await b.page.locator(".share-message-list button").click();
  await expect(b.page.locator(".share-markdown h1")).toHaveText("작업 결과");
  await expect(
    b.page.locator(
      ".share-markdown a, .share-markdown img, .share-markdown iframe, .share-markdown script",
    ),
  ).toHaveCount(0);
  expect(
    await b.page.evaluate(() => (window as any).__shareExecuted),
  ).toBeUndefined();
  expect(network).toEqual([]);
  await b.page.getByRole("button", { name: "코드 복사", exact: true }).click();
  expect(await b.app.evaluate(() => (globalThis as any).__shareCopied)).toBe(
    "echo hello\n",
  );
  await b.page.getByRole("button", { name: "전체 Markdown 복사" }).click();
  expect(await b.app.evaluate(() => (globalThis as any).__shareCopied)).toBe(
    text,
  );

  const file = path.join(root, "첨부.html"),
    content = "<script>throw new Error('must not open')</script>";
  await fs.writeFile(file, content);
  await a.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
  await a.page.getByRole("button", { name: "파일 선택", exact: true }).click();
  await expect(
    a.page.getByRole("button", { name: "쪽지 보내기", exact: true }),
  ).toBeDisabled();
  expect((await snapshot(b.page)).transfers).toEqual([]);
  await expect(a.page.locator(".share-attachment")).toContainText("첨부.html");
  await a.page.getByRole("button", { name: "첨부 제거" }).click();
  await expect(a.page.locator(".share-attachment")).toHaveCount(0);
  await a.page.getByRole("button", { name: "파일 선택", exact: true }).click();
  // Cancelling a replacement picker preserves the selected attachment.
  await a.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await a.page.getByRole("button", { name: "파일 선택", exact: true }).click();
  await expect(a.page.locator(".share-attachment")).toContainText("첨부.html");
  await a.page
    .getByRole("textbox", { name: "Markdown 쪽지", exact: true })
    .fill("# 첨부 검토\n\n내용을 확인해 주세요.");
  await a.page
    .getByRole("button", { name: "쪽지 보내기", exact: true })
    .click();
  await selectPending(b.page);
  await expect(
    b.page.getByRole("button", { name: "승인하고 저장" }),
  ).toBeVisible();
  expect(await fs.readdir(b.directory)).toEqual([]);
  await b.page.getByRole("button", { name: "승인하고 저장" }).click();
  await expect
    .poll(() =>
      fs.readFile(path.join(b.directory, "첨부.html"), "utf8").catch(() => ""),
    )
    .toBe(content);
  await expect
    .poll(async () => (await snapshot(b.page)).transfers.length)
    .toBe(0);
  expect(await fs.readdir(b.directory)).toEqual(["첨부.html"]);
  await expect(b.page.locator(".share-message-list button")).toHaveCount(2);
  await b.page
    .getByRole("textbox", { name: "받은 쪽지 검색" })
    .fill("첨부.html");
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
  await b.page
    .locator(".share-message-list button")
    .filter({ hasText: "첨부 검토" })
    .click();
  await expect(b.page.locator(".share-markdown h1")).toHaveText("첨부 검토");
  await expect(b.page.getByRole("region", { name: "첨부 파일" })).toContainText(
    "첨부.html",
  );
  await b.page.getByRole("textbox", { name: "받은 쪽지 검색" }).fill("");
  for (const theme of ["dark", "light"] as const) {
    await setTheme(b.page, theme);
    await b.page.screenshot({
      path: test.info().outputPath(`received-message-${theme}.png`),
    });
    expect(
      await b.page
        .locator(".sharing-view")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  expect(await b.app.evaluate(() => (globalThis as any).__shareOpened)).toEqual(
    [],
  );
  await b.page
    .getByRole("button", { name: "첨부 경로 복사", exact: true })
    .click();
  expect(await b.app.evaluate(() => (globalThis as any).__shareCopied)).toBe(
    path.join(b.directory, "첨부.html"),
  );
  await b.page
    .getByRole("button", { name: "첨부 파일 열기", exact: true })
    .click();
  expect(await b.app.evaluate(() => (globalThis as any).__shareOpened)).toEqual(
    [path.join(b.directory, "첨부.html")],
  );
  await fs.rename(
    path.join(b.directory, "첨부.html"),
    path.join(b.directory, "moved.html"),
  );
  await b.page
    .getByRole("button", { name: "첨부 파일 열기", exact: true })
    .click();
  await expect(b.page.getByRole("alert")).toContainText(
    "저장한 파일을 찾을 수 없습니다.",
  );
  expect(
    await b.app.evaluate(() => (globalThis as any).__shareOpened),
  ).toHaveLength(1);
  await fs.rename(
    path.join(b.directory, "moved.html"),
    path.join(b.directory, "첨부.html"),
  );
  await b.page.getByRole("button", { name: "쪽지 삭제", exact: true }).click();
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
  await b.page.locator(".share-message-list button").click();
  await b.page.getByRole("button", { name: "쪽지 삭제", exact: true }).click();
  await expect(b.page.locator(".share-message-list button")).toHaveCount(0);
  expect(await fs.readFile(path.join(b.directory, "첨부.html"), "utf8")).toBe(
    content,
  );
  const deeplyNested = ">".repeat(12000) + " unsafe nesting";
  await a.page
    .getByRole("textbox", { name: "Markdown 쪽지", exact: true })
    .fill(deeplyNested);
  await a.page
    .getByRole("button", { name: "쪽지 보내기", exact: true })
    .click();
  await selectPending(b.page);
  await b.page.getByRole("button", { name: "쪽지 받기", exact: true }).click();
  await expect(
    b.page.locator(".share-message-list button.pending"),
  ).toHaveCount(0);
  await b.page.locator(".share-message-list button").click();
  await expect(b.page.locator(".share-markdown .hint")).toContainText(
    "원문을 표시",
  );
  await expect(b.page.locator(".share-markdown pre")).toHaveText(deeplyNested);
  await b.page.getByRole("button", { name: "전체 Markdown 복사" }).click();
  expect(await b.app.evaluate(() => (globalThis as any).__shareCopied)).toBe(
    deeplyNested,
  );
  await a.page.getByRole("button", { name: "서식 편집", exact: true }).click();
  await a.page
    .getByRole("textbox", { name: "쪽지", exact: true })
    .fill("서식 전송 확인");
  await a.page.getByRole("button", { name: "제목", exact: true }).click();
  await a.page
    .getByRole("button", { name: "쪽지 보내기", exact: true })
    .click();
  await selectPending(b.page);
  await b.page.getByRole("button", { name: "쪽지 받기", exact: true }).click();
  await expect(
    b.page.locator(".share-message-list button.pending"),
  ).toHaveCount(0);
  await b.page
    .locator(".share-message-list button")
    .filter({ hasText: "서식 전송 확인" })
    .click();
  await expect(b.page.locator(".share-markdown h1")).toHaveText(
    "서식 전송 확인",
  );

  const beforeReject = (await snapshot(b.page)).messages.length;
  await a.page.evaluate(() =>
    window.passport.call("share.send", { to: "지수", text: "거절할 쪽지" }),
  );
  await selectPending(b.page);
  await b.page.getByRole("button", { name: "거절", exact: true }).click();
  await expect(
    b.page.locator(".share-message-list button.pending"),
  ).toHaveCount(0);
  expect((await snapshot(b.page)).messages.length).toBe(beforeReject);
  await expect(b.page.locator(".share-pending-reader")).toHaveCount(0);
  const peer = (await snapshot(a.page)).peers[0];
  await a.page.getByRole("button", { name: "쪽지 설정", exact: true }).click();
  await a.page.getByRole("button", { name: "지수 수정", exact: true }).click();
  const edit = a.page.getByRole("dialog", { name: "친구 수정" });
  await edit.getByLabel("이름", { exact: true }).fill("지수 새 이름");
  await edit.getByLabel("연결 주소", { exact: true }).fill("invalid:0");
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  await expect(edit.getByRole("alert")).toBeVisible();
  expect((await snapshot(a.page)).peers[0].name).toBe("지수");
  await edit
    .getByLabel("연결 주소", { exact: true })
    .fill(`${peer.endpoint.address}:${peer.endpoint.port}`);
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect((await snapshot(a.page)).peers[0].name).toBe("지수 새 이름");
  await a.page.locator('.app-tab[aria-label="쪽지"]').click();
  await a.page.getByRole("tab", { name: "보내기", exact: true }).click();
  const recipient = a.page.getByRole("combobox", {
    name: "받는 사람",
    exact: true,
  });
  await recipient.fill(peer.id.slice(0, 10));
  await expect(a.page.getByRole("option")).toHaveCount(1);
  await recipient.press("Enter");
  await expect(recipient).toHaveValue("지수 새 이름");
  await a.page.getByRole("button", { name: "쪽지 설정", exact: true }).click();
  await a.page
    .getByRole("button", { name: "지수 새 이름 삭제", exact: true })
    .click();
  await a.page
    .getByRole("dialog", { name: "친구 삭제" })
    .getByRole("button", { name: "확인", exact: true })
    .click();
  await expect.poll(async () => (await snapshot(a.page)).peers.length).toBe(0);
});

test("dismisses expired registration errors across refresh and shows new occurrences", async () => {
  const a = await launch("expiry-a"),
    b = await launch("expiry-b");
  const expire = async () => {
    const invitation = await b.page.evaluate(() =>
      window.passport.call("share.invite", undefined),
    );
    await a.page.evaluate(
      (key) => window.passport.call("share.join", { key, alias: "친구" }),
      invitation.key,
    );
    await expect
      .poll(async () => (await snapshot(b.page)).requests.length)
      .toBe(1);
    await a.app.evaluate(() => {
      const state = globalThis as any;
      state.__expiryOriginalNow ??= Date.now;
      Date.now = () => state.__expiryOriginalNow() + 6 * 60 * 1000;
    });
    await expect
      .poll(async () => (await snapshot(a.page)).error)
      .toBe("등록 요청이 만료되었습니다.");
    await a.app.evaluate(() => {
      Date.now = (globalThis as any).__expiryOriginalNow;
    });
  };
  try {
    await expire();
    await expect(a.page.getByRole("alert")).toContainText(
      "등록 요청이 만료되었습니다.",
    );
    await a.page
      .getByRole("button", { name: "알림 닫기", exact: true })
      .click();
    await expect(a.page.getByRole("alert")).toHaveCount(0);
    expect((await snapshot(a.page)).error).toBeUndefined();
    await a.page.locator('.app-tab[aria-label="쪽지"]').click();
    await expect(a.page.getByRole("alert")).toHaveCount(0);
    await a.page.reload();
    await a.page.locator('.app-tab[aria-label="쪽지"]').click();
    await expect(a.page.getByRole("alert")).toHaveCount(0);
    await expire();
    await expect(a.page.getByRole("alert")).toContainText(
      "등록 요청이 만료되었습니다.",
    );
    await a.page
      .getByRole("button", { name: "알림 닫기", exact: true })
      .click();
    await expect(a.page.getByRole("alert")).toHaveCount(0);
  } finally {
    await a.app.evaluate(() => {
      const state = globalThis as any;
      if (state.__expiryOriginalNow) Date.now = state.__expiryOriginalNow;
      delete state.__expiryOriginalNow;
    });
  }
});

test("lets both peers send, approve and read notes with the real CLI without terminal access", async () => {
  const { a, b } = await pair();
  await a.page.evaluate(async () => {
    const boot = await window.passport.call("bootstrap", undefined);
    boot.document.settings.terminal.cliAccess = "off";
    boot.document.settings.terminal.shell =
      boot.platform === "win32" ? "passport-bash" : "bash";
    boot.document.settings.terminal.profileIds = [];
    await window.passport.call("save", boot.document);
  });
  await a.page.getByRole("button", { name: "시작", exact: true }).click();
  await a.page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(a.page.locator(".xterm-rows")).toContainText(/\$\s*$/);
  const source = await a.page.evaluate(
    async () =>
      (await window.passport.call("bootstrap", undefined)).sessionStates[0].id,
  );
  const cli = await cliCoordinator(a.page, source, root);
  const friends = await cli(["share", "friends"]);
  expect(friends.ok).toBe(true);
  expect(friends.value[0]).toMatchObject({
    name: "지수",
    id: (await snapshot(a.page)).peers[0].id,
  });
  expect((await cli(["share", "peers"])).value[0].name).toBe("지수");
  expect((await cli(["list"])).ok).toBe(false);
  expect((await cli(["share", "approve", "invalid"])).ok).toBe(false);
  expect((await cli(["share", "read", "invalid"])).ok).toBe(false);
  const request = await cli(
    ["share", "send", "--to", "지수", "--markdown-file", "-"],
    "# CLI 쪽지\n\n한글 본문",
  );
  expect(request.ok).toBe(true);
  expect(request.value.state).toBe("preparing");
  await selectPending(b.page);
  await expect(
    b.page.getByRole("button", { name: "쪽지 받기", exact: true }),
  ).toBeVisible();
  expect((await snapshot(b.page)).messages).toEqual([]);
  expect((await cli(["share", "status", request.value.id])).value.state).toBe(
    "pending",
  );
  await selectPending(b.page);
  await b.page.getByRole("button", { name: "쪽지 받기", exact: true }).click();
  await expect(
    b.page.locator(".share-message-list button.pending"),
  ).toHaveCount(0);
  // Observe completion before starting the CLI process. Nesting the helper's
  // 10s command wait inside a 5s poll could abandon a still-running CLI call
  // and report its previous "pending" value after the receiver had saved it.
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
  await expect
    .poll(async () =>
      (await snapshot(a.page)).transfers.some((t) => t.id === request.value.id),
    )
    .toBe(false);
  const receipt = await cli(["share", "status", request.value.id]);
  expect(receipt.ok).toBe(true);
  expect(receipt.value.state).toBe("delivered");
  await b.page.locator(".share-message-list button").click();
  await expect(b.page.locator(".share-markdown h1")).toHaveText("CLI 쪽지");
  // b received the friend request; its CLI must work in both directions too.
  await b.page.evaluate(async () => {
    const boot = await window.passport.call("bootstrap", undefined);
    boot.document.settings.terminal.cliAccess = "off";
    boot.document.settings.terminal.shell =
      boot.platform === "win32" ? "passport-bash" : "bash";
    boot.document.settings.terminal.profileIds = [];
    await window.passport.call("save", boot.document);
  });
  await b.page.getByRole("button", { name: "시작", exact: true }).click();
  await b.page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(b.page.locator(".xterm-rows")).toContainText(/\$\s*$/);
  const receiverPane = (
    await b.page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).sessionStates[0].id;
  const receiverCli = await cliCoordinator(b.page, receiverPane, root);
  expect((await receiverCli(["share", "friends"])).value[0].name).toBe("승민");
  expect(
    (await receiverCli(["share", "read", request.value.id])).value.markdown,
  ).toBe("# CLI 쪽지\n\n한글 본문");
  const reply = await receiverCli([
    "share",
    "send",
    "--to",
    "승민",
    "--text",
    "받은 사람의 CLI 답장",
  ]);
  expect(reply.ok).toBe(true);
  await expect
    .poll(async () =>
      (await snapshot(a.page)).transfers.some((t) => t.id === reply.value.id),
    )
    .toBe(true);
  expect((await cli(["share", "inbox"])).value.pending).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: reply.value.id, state: "pending" }),
    ]),
  );
  expect((await cli(["share", "read", reply.value.id])).ok).toBe(false);
  expect((await cli(["share", "approve", reply.value.id])).value.state).toBe(
    "accepted",
  );
  await expect
    .poll(async () =>
      (await snapshot(a.page)).messages.some((m) => m.id === reply.value.id),
    )
    .toBe(true);
  expect((await cli(["share", "status", reply.value.id])).value.state).toBe(
    "delivered",
  );
  expect((await cli(["share", "read", reply.value.id])).value.markdown).toBe(
    "받은 사람의 CLI 답장",
  );
  expect((await cli(["share", "inbox"])).value.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: reply.value.id })]),
  );
  await b.page.locator('.app-tab[aria-label="쪽지"]').click();
  const pending = await cli([
    "share",
    "send",
    "--to",
    "지수",
    "--text",
    "cancel me",
  ]);
  await selectPending(b.page);
  await expect(
    b.page.getByRole("button", { name: "쪽지 받기", exact: true }),
  ).toBeVisible();
  expect((await cli(["share", "cancel", pending.value.id])).ok).toBe(true);
  await expect(
    b.page.getByRole("button", { name: "쪽지 받기", exact: true }),
  ).toHaveCount(0);
  await a.page.evaluate(async () => {
    const current = await window.passport.call("share.state", undefined);
    await window.passport.call("share.configure", {
      ...current.settings,
      enabled: false,
    });
  });
  expect((await cli(["share", "peers"])).ok).toBe(false);
});
