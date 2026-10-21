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
  // Electron needs this known folder before launching with an isolated profile.
  await fs.mkdir(path.join(root, "Downloads"));
  errors.length = 0;
});
test.afterEach(async () => {
  try {
    for (const app of apps.splice(0).reverse()) {
      await app.evaluate(({ safeStorage, clipboard, dialog }) => {
        const original = (globalThis as any).__shareOriginal;
        if (!original) return;
        Object.assign(safeStorage, original.safeStorage);
        clipboard.writeText = original.writeText;
        dialog.showOpenDialog = original.showOpenDialog;
        delete (globalThis as any).__shareOriginal;
        delete (globalThis as any).__shareCopied;
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
  await app.evaluate(({ safeStorage, clipboard, dialog }) => {
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
  });
  await page.getByRole("button", { name: "공유함", exact: true }).click();
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
  await page.getByRole("button", { name: "공유 설정", exact: true }).click();
  await expect(page.getByLabel("내 표시 이름", { exact: true })).toHaveCount(0);
  const apply = page.getByRole("button", { name: "공유 설정 적용" });
  await expect(apply).toBeDisabled();
  await page.getByLabel("공유 사용", { exact: true }).check();
  await expect(apply).toBeDisabled();
  await page.getByLabel("사용할 네트워크").selectOption("127.0.0.1");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect
    .poll(async () => (await snapshot(page)).endpoint?.address)
    .toBe("127.0.0.1");
  await expect(apply).toBeDisabled();
  await page.getByLabel("메시지 자동 정리").selectOption("30");
  await expect(apply).toBeEnabled();
  await page.getByLabel("메시지 자동 정리").selectOption("7");
  await expect(apply).toBeDisabled();
  return { app, page, directory };
}
async function pair() {
  const a = await launch("승민"),
    b = await launch("지수");
  await b.page.getByRole("button", { name: "공유함", exact: true }).click();
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
  await b.page.getByRole("button", { name: "공유함", exact: true }).click();
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
  await a.page.getByRole("button", { name: "공유함", exact: true }).click();
  await expect(
    a.page.getByRole("tab", { name: "받은 메시지", exact: true }),
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
  ).toHaveValue((await snapshot(a.page)).peers[0].id);
  return { a, b };
}

test("validates sharing settings and separates inbox, sending and friends with aligned controls", async () => {
  const { app, page, directory } = await launch("sharing-ui");
  const apply = page.getByRole("button", { name: "공유 설정 적용" });
  await page.getByLabel("메시지 자동 정리").selectOption("30");
  await apply.click();
  await expect(apply).toBeDisabled();
  expect((await snapshot(page)).settings.retentionDays).toBe(30);
  await page.getByLabel("사용할 네트워크").selectOption("");
  await expect(apply).toBeDisabled();
  // A missing network must never prevent turning sharing off.
  await page.getByLabel("공유 사용", { exact: true }).uncheck();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(apply).toBeDisabled();
  await page.getByRole("button", { name: "공유함", exact: true }).click();
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
  await page.getByRole("button", { name: "공유 설정", exact: true }).click();
  await page.getByLabel("공유 사용", { exact: true }).check();
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
        has: page.getByRole("button", { name: "공유 기기키 초기화" }),
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
  await page.getByRole("button", { name: "공유함", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "받은 메시지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Markdown 메시지", exact: true }),
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
  const key = await app.evaluate(() => (globalThis as any).__shareCopied);
  await page.getByRole("button", { name: "등록키 복사", exact: true }).click();
  expect(await app.evaluate(() => (globalThis as any).__shareCopied)).toBe(key);
  await page.getByRole("tab", { name: "보내기", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 메시지", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "보관 메시지 불러오기" }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Markdown 메시지", exact: true })
    .fill("보내기 초안");
  await page.getByRole("button", { name: "공유함", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "받은 메시지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "보내기", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 메시지", exact: true }),
  ).toHaveValue("보내기 초안");
  await page.getByRole("tab", { name: /내 친구/ }).click();
  await expect(page.locator(".share-friends")).toContainText(
    "아직 등록된 친구가 없습니다.",
  );
  await page.getByRole("button", { name: "친구 목록 불러오기" }).click();
  await page.getByRole("tab", { name: /내 친구/ }).focus();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "받은 메시지", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "받은 메시지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("pairs two devices, approves encrypted Markdown, renders inert content and saves protected attachments only", async () => {
  const { a, b } = await pair();
  const network: string[] = [];
  b.page.on("request", (req) => {
    if (req.url().includes("share-example.invalid")) network.push(req.url());
  });
  const text =
    '# 작업 결과\n\n[외부 링크](https://share-example.invalid/)\n\n![외부 이미지](https://share-example.invalid/pixel.png)\n\n<script>window.__shareExecuted=true</script>\n\n<iframe src="https://share-example.invalid/"></iframe>\n\n```sh\necho hello\n```';
  await a.page
    .getByRole("combobox", { name: "받는 사람", exact: true })
    .selectOption((await snapshot(a.page)).peers[0].id);
  await a.page
    .getByRole("textbox", { name: "Markdown 메시지", exact: true })
    .fill(text);
  await a.page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(
    b.page.getByRole("button", { name: "메시지 받기", exact: true }),
  ).toBeVisible();
  expect((await snapshot(b.page)).messages).toEqual([]);
  await b.page
    .getByRole("button", { name: "메시지 받기", exact: true })
    .click();
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
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
  await a.page
    .getByRole("button", { name: "파일 보내기", exact: true })
    .click();
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
  await expect(b.page.locator(".share-message-list button")).toHaveCount(1);
  await expect(
    b.page
      .locator(".sharing-view")
      .getByRole("button", { name: /파일 열기|실행|미리보기/ }),
  ).toHaveCount(0);
  await b.page
    .getByRole("button", { name: "메시지 삭제", exact: true })
    .click();
  await expect(b.page.locator(".share-message-list button")).toHaveCount(0);
  expect(await fs.readFile(path.join(b.directory, "첨부.html"), "utf8")).toBe(
    content,
  );
  const deeplyNested = ">".repeat(12000) + " unsafe nesting";
  await a.page
    .getByRole("textbox", { name: "Markdown 메시지", exact: true })
    .fill(deeplyNested);
  await a.page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await b.page
    .getByRole("button", { name: "메시지 받기", exact: true })
    .click();
  await b.page.locator(".share-message-list button").click();
  await expect(b.page.locator(".share-markdown .hint")).toContainText(
    "원문을 표시",
  );
  await expect(b.page.locator(".share-markdown pre")).toHaveText(deeplyNested);
  await b.page.getByRole("button", { name: "전체 Markdown 복사" }).click();
  expect(await b.app.evaluate(() => (globalThis as any).__shareCopied)).toBe(
    deeplyNested,
  );
});

test("lets the real CLI send to a registered alias without terminal access and cannot approve or read incoming messages", async () => {
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
    blocked: false,
  });
  expect((await cli(["share", "peers"])).value[0].name).toBe("지수");
  expect((await cli(["list"])).ok).toBe(false);
  expect((await cli(["share", "approve", "invalid"])).ok).toBe(false);
  expect((await cli(["share", "read", "invalid"])).ok).toBe(false);
  const request = await cli(
    ["share", "send", "--to", "지수", "--markdown-file", "-"],
    "# CLI 메시지\n\n한글 본문",
  );
  expect(request.ok).toBe(true);
  expect(request.value.state).toBe("preparing");
  await expect(
    b.page.getByRole("button", { name: "메시지 받기", exact: true }),
  ).toBeVisible();
  expect((await snapshot(b.page)).messages).toEqual([]);
  expect((await cli(["share", "status", request.value.id])).value.state).toBe(
    "pending",
  );
  await b.page
    .getByRole("button", { name: "메시지 받기", exact: true })
    .click();
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
  await expect(b.page.locator(".share-markdown h1")).toHaveText("CLI 메시지");
  const pending = await cli([
    "share",
    "send",
    "--to",
    "지수",
    "--text",
    "cancel me",
  ]);
  await expect(
    b.page.getByRole("button", { name: "메시지 받기", exact: true }),
  ).toBeVisible();
  expect((await cli(["share", "cancel", pending.value.id])).ok).toBe(true);
  await expect(
    b.page.getByRole("button", { name: "메시지 받기", exact: true }),
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
