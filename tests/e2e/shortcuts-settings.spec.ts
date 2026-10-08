import { test, expect, type Page } from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";
import { waitForLocalPrompt } from "../fixtures/terminal-ready";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultShortcuts } from "../../src/shared/shortcuts";
import { hostSchema } from "../../src/shared/model";
import { randomUUID } from "node:crypto";
import { expectReadableSpacing } from "../fixtures/ui-spacing";

const suite = reusableApp({ name: "shortcuts-settings" });
const os = process.platform === "darwin" ? "darwin" : "win32";
const other = os === "darwin" ? "win32" : "darwin";
const mod = os === "darwin" ? "Meta" : "Control";
const boot = (page: Page) =>
  page.evaluate(() => window.passport.call("bootstrap", undefined));
async function settings(page: Page, name: string) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name, exact: true })
    .click();
}

test("shortcut editor replaces one key, rejects conflicts and persists only the current OS", async () => {
  const { page, application } = suite;
  const before = await boot(page);
  await settings(page, "단축키");
  await expect(
    page.getByRole("heading", {
      name: `${os === "darwin" ? "macOS" : "Windows"} 단축키`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: `${os === "darwin" ? "Windows" : "macOS"} 단축키`,
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "새 탭 · 로컬 터미널 키 변경", exact: true })
    .click();
  await page.getByLabel("키 조합", { exact: true }).press(`${mod}+Shift+n`);
  expect(await application.windows()).toHaveLength(1);
  expect((await boot(page)).document.workspaces).toHaveLength(0);
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "중복",
  );
  await page.getByLabel("키 조합", { exact: true }).press(`${mod}+Shift+y`);
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await page
    .getByRole("button", { name: "복사 단축키 해제", exact: true })
    .click();
  await page.getByRole("button", { name: "단축키 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  let saved = (await boot(page)).document.settings.shortcuts;
  expect(saved[os].newTab).toEqual([
    `${os === "darwin" ? "Meta" : "Ctrl"}+Shift+Y`,
  ]);
  expect(saved[os].copy).toEqual([]);
  expect(saved[other]).toEqual(before.document.settings.shortcuts[other]);
  await expect(
    page.getByRole("button", { name: "복사 단축키 해제", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press(`${mod}+n`);
  expect((await boot(page)).document.workspaces).toHaveLength(0);
  await settings(page, "외형");
  await page.getByRole("tab", { name: "터미널 설정", exact: true }).click();
  const fontQuery = page.getByLabel("글꼴 검색", { exact: true });
  await fontQuery.fill("JetBrains");
  await fontQuery.press(`${mod}+Shift+y`);
  expect((await boot(page)).document.workspaces).toHaveLength(0);
  await fontQuery.press(`${mod}+a`);
  expect(
    await fontQuery.evaluate(
      (el) =>
        (el as HTMLInputElement).selectionEnd! -
        (el as HTMLInputElement).selectionStart!,
    ),
  ).toBe(9);
  await page.reload();
  await settings(page, "단축키");
  await expect(page.locator('[data-shortcut-action="copy"]')).toContainText(
    "사용 안 함",
  );
  await expect(
    page.locator('[data-shortcut-action="newTab"] .shortcut-key kbd'),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "복사 초기화", exact: true }).click();
  await page
    .getByRole("button", { name: "새 탭 · 로컬 터미널 키 변경", exact: true })
    .click();
  await page.getByLabel("키 조합", { exact: true }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "변경 취소", exact: true }).click();
  await expect(page.locator('[data-shortcut-action="copy"]')).toContainText(
    "사용 안 함",
  );
  // The new binding works after reload; the replaced binding did not open a tab.
  await page.keyboard.press(`${mod}+Shift+y`);
  await expect
    .poll(async () => (await boot(page)).document.workspaces.length)
    .toBe(1);
  await settings(page, "단축키");
  await page.getByRole("button", { name: "전체 초기화", exact: true }).click();
  await page.getByRole("button", { name: "단축키 저장", exact: true }).click();
  await expect
    .poll(async () => (await boot(page)).document.settings.shortcuts[os])
    .toEqual(defaultShortcuts[os]);
});

test("Windows shortcut routing copies without interrupt and honors disabled controls and paste under injected platform", async () => {
  const { page, application } = suite;
  // Only the renderer platform is injected. This is not a Windows native test.
  await application.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers;
    const original = handlers.get("passport:call");
    (globalThis as any).__shortcutIO = {
      inputs: [],
      copies: [],
      reads: 0,
      capture: false,
    };
    ipcMain.removeHandler("passport:call");
    ipcMain.handle("passport:call", async (event, name, input) => {
      const state = (globalThis as any).__shortcutIO;
      if (state.capture && name === "session.input") {
        // Keep ConPTY device/focus replies flowing to the real shell, as in
        // paste.spec.ts; they are not shortcut-generated input bytes.
        if (
          process.platform === "win32" &&
          ["\x1b[?1;2c", "\x1b[I", "\x1b[O"].includes(input.data)
        )
          return original(event, name, input);
        state.inputs.push(input.data);
        return { ok: true, value: undefined };
      }
      if (name === "clipboard.write") {
        state.copies.push(input.text);
        return { ok: true, value: undefined };
      }
      if (name === "clipboard.terminal") {
        state.reads++;
        return { ok: true, value: { kind: "text", text: "PASTE_ONCE" } };
      }
      const result = await original(event, name, input);
      if (name === "bootstrap" && result.ok) result.value.platform = "win32";
      return result;
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  const area = page.locator(".view:not([hidden]) .xterm-helper-textarea");
  await waitForLocalPrompt(page);
  await area.focus();
  await page.keyboard.type("echo COPY_MARKER");
  await page.keyboard.press("Enter");
  await expect(page.locator(".view:not([hidden]) .xterm-rows")).toContainText(
    "COPY_MARKER",
  );
  await application.evaluate(() => {
    (globalThis as any).__shortcutIO.capture = true;
  });
  const state = () =>
    application.evaluate(
      () =>
        (globalThis as any).__shortcutIO as {
          inputs: string[];
          copies: string[];
          reads: number;
        },
    );
  await page.keyboard.press("Control+c");
  expect((await state()).inputs).toEqual([]);
  expect((await state()).copies).toEqual([]);
  await page.getByRole("button", { name: "터미널 검색", exact: true }).click();
  await page.getByLabel("터미널 출력 검색").fill("COPY_MARKER");
  await expect(page.getByRole("status", { name: "검색 결과" })).not.toHaveText(
    "0/0",
  );
  await area.focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await state()).copies)
    .toEqual(["COPY_MARKER"]);
  expect((await state()).inputs).toEqual([]);
  await page.keyboard.press("Control+Shift+c");
  await expect.poll(async () => (await state()).inputs).toEqual(["\x03"]);
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await state()).reads).toBe(1);
  await expect.poll(async () => (await state()).inputs.length).toBe(2);
  expect((await state()).inputs[1]).toContain("PASTE_ONCE");
  const rows = page.locator(".view:not([hidden]) .xterm-rows");
  const fontSize = () =>
    rows.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const initial = await fontSize();
  await page.keyboard.press("Control+Shift+v");
  await page.keyboard.press("Control+Shift+Equal");
  expect((await state()).reads).toBe(1);
  expect((await state()).inputs).toHaveLength(2);
  expect(await fontSize()).toBe(initial);
  await page.keyboard.press("Control+Equal");
  await expect.poll(fontSize).toBe(initial + 1);
  await page.evaluate(async () => {
    const { document } = await window.passport.call("bootstrap", undefined);
    const keys = document.settings.shortcuts.win32;
    keys.copy = [];
    keys.paste = [];
    keys.interrupt = ["Ctrl+Shift+K"];
    keys.eof = [];
    keys.suspend = [];
    keys.zoomIn = [];
    await window.passport.call("save", document);
  });
  // A renderer round trip lets the settings effect apply before the next key.
  await expect
    .poll(async () => (await boot(page)).document.settings.shortcuts.win32.copy)
    .toEqual([]);
  await page.waitForTimeout(80);
  await area.focus();
  for (const key of [
    "Control+c",
    "Control+v",
    "Control+Shift+v",
    "Control+Shift+c",
    "Control+d",
    "Control+z",
    "Control+Equal",
    "Control+Shift+Equal",
  ])
    await page.keyboard.press(key);
  await page.waitForTimeout(80);
  expect((await state()).inputs).toHaveLength(2);
  expect((await state()).copies).toEqual(["COPY_MARKER"]);
  expect((await state()).reads).toBe(1);
  expect(await fontSize()).toBe(initial + 1);
  await page.keyboard.press("Control+Shift+k");
  await expect.poll(async () => (await state()).inputs).toHaveLength(3);
  expect((await state()).inputs[2]).toBe("\x03");
});

test("file shortcuts use custom bindings and retain rename and delete dialogs", async () => {
  const { page, directory } = suite;
  const folder = path.join(directory, "shortcut-files");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "one.txt"), "one");
  await fs.writeFile(path.join(folder, "two.txt"), "two");
  await page.evaluate(async (os) => {
    const { document } = await window.passport.call("bootstrap", undefined);
    Object.assign(
      document.settings.shortcuts[os === "darwin" ? "darwin" : "win32"],
      {
        fileSelectAll: ["Alt+A"],
        fileRename: ["Alt+R"],
        fileDelete: ["Alt+D"],
        fileMenu: ["Alt+M"],
      },
    );
    await window.passport.call("save", document);
  }, os);
  await page.getByRole("button", { name: "파일", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "왼쪽 파일 패널",
    exact: true,
  });
  const input = panel.getByLabel("왼쪽 경로");
  await expect(input).not.toHaveValue("");
  await input.fill(folder);
  await input.press("Enter");
  const rows = panel.locator("tbody tr:not(.parent-row)");
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await rows.first().press(`${mod}+a`);
  await expect(panel.locator("tbody tr.selected")).toHaveCount(1);
  await rows.first().press("Alt+a");
  await expect(panel.locator("tbody tr.selected")).toHaveCount(2);
  await rows.first().press("F2");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await rows.first().press("Alt+r");
  const rename = page.getByRole("dialog", { name: "이름 변경", exact: true });
  await expect(rename).toBeVisible();
  await rename.locator("input").fill("renamed.txt");
  await rename.getByRole("button", { name: "적용", exact: true }).click();
  await expect(panel.locator("tbody")).toContainText("renamed.txt");
  const renamed = rows.filter({ hasText: "renamed.txt" });
  await renamed.click();
  await renamed.press("Shift+F10");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await renamed.press("ContextMenu");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await renamed.press("Alt+m");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await renamed.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await renamed.press("Delete");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await renamed.press("Alt+d");
  const deletion = page.getByRole("dialog", { name: "파일 삭제", exact: true });
  await expect(deletion).toContainText("휴지통으로 이동하지 않습니다");
  await deletion.getByRole("button", { name: "취소", exact: true }).click();
  expect(await fs.readFile(path.join(folder, "renamed.txt"), "utf8")).toBe(
    "one",
  );
  // Use the real editor and its saved state as the renderer update barrier.
  // A direct save IPC reply can arrive before React applies the document event.
  await settings(page, "단축키");
  await page
    .getByRole("button", {
      name: "파일 컨텍스트 메뉴 단축키 해제",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "단축키 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  await page.getByRole("button", { name: "파일", exact: true }).click();
  for (const key of ["Alt+m", "Shift+F10", "ContextMenu"]) {
    await renamed.press(key);
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await settings(page, "단축키");
  await page
    .getByRole("button", {
      name: "파일 컨텍스트 메뉴 초기화",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "단축키 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  await page.getByRole("button", { name: "파일", exact: true }).click();
  await renamed.press("ContextMenu");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await renamed.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("settings cards and form controls scroll the page while log panes keep independent scrolling", async ({}, info) => {
  const { page, application } = suite;
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 680),
  );
  await settings(page, "외형");
  await page.getByRole("tab", { name: "터미널 설정", exact: true }).click();
  const content = page.locator(".settings-content");
  await expect(page.locator(".appearance-panel.tool-body")).toHaveCount(0);
  for (const selector of [
    ".appearance-panel",
    ".font-picker input",
    ".font-preview",
  ]) {
    await content.evaluate((el) => {
      el.scrollTop = 0;
    });
    const target = page.locator(selector);
    const box = await target.boundingBox();
    const outer = (await content.boundingBox())!;
    expect(box).not.toBeNull();
    await page.mouse.move(
      box!.x + Math.min(15, box!.width / 2),
      Math.min(box!.y + 8, outer.y + outer.height - 15),
    );
    await page.mouse.wheel(0, 360);
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  }
  let scrollingPanels = 0;
  for (const section of [
    "외형",
    "로컬 터미널",
    "AI 작업 알림",
    "포트 포워딩",
    "세션 로그",
    "그룹 관리",
    "인증 프로필",
    "내보내기와 백업",
    "단축키",
    "About",
  ]) {
    await settings(page, section);
    const tabs = await page.locator('.settings-tab-list [role="tab"]').all();
    for (const tab of tabs.length ? tabs : [null]) {
      if (tab) await tab.click();
      await content.evaluate((el) => {
        el.scrollTop = 0;
      });
      const dimensions = await content.evaluate((el) => ({
        height: el.clientHeight,
        scroll: el.scrollHeight,
        overflow: getComputedStyle(el).overflowY,
        horizontal: el.scrollWidth > el.clientWidth + 1,
      }));
      expect(dimensions.horizontal, `${section}: horizontal overflow`).toBe(
        false,
      );
      if (
        dimensions.overflow !== "auto" ||
        dimensions.scroll <= dimensions.height + 1
      )
        continue;
      const card = page.locator(".settings-content .settings-card").first();
      if (!(await card.count())) continue;
      const rect = (await card.boundingBox())!;
      const outer = (await content.boundingBox())!;
      await page.mouse.move(
        rect.x + 30,
        Math.max(
          outer.y + 5,
          Math.min(rect.y + 35, outer.y + outer.height - 15),
        ),
      );
      await page.mouse.wheel(0, 300);
      await expect
        .poll(() => content.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      scrollingPanels++;
    }
  }
  expect(scrollingPanels).toBeGreaterThanOrEqual(4);
  await settings(page, "외형");
  await page.getByRole("tab", { name: "터미널 설정", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("appearance-terminal-scroll.png"),
  });
  await settings(page, "단축키");
  await content.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath("shortcut-editor.png") });
  await settings(page, "세션 로그");
  await expect(content).toHaveCSS("overflow-y", "hidden");
  await expect(page.locator(".log-settings .settings-tab-panel")).toBeVisible();
});

test("home and populated settings dialogs keep related controls and help separated", async ({}, info) => {
  const { page, application } = suite;
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "간격 검증 서버",
    address: "127.0.0.1",
    username: "tester",
  });
  await page.evaluate(async (host) => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.hosts = [host];
    document.tunnels = [
      {
        id: crypto.randomUUID(),
        hostId: host.id,
        name: "간격 검증 터널",
        kind: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        targetAddress: "127.0.0.1",
        targetPort: 5432,
      },
    ];
    await window.passport.call("save", document);
  }, host);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 680),
  );
  for (const mode of ["dark", "light"] as const) {
    await page.evaluate(async (mode) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.settings.colorMode = mode;
      await window.passport.call("save", document);
    }, mode);
    const capture = async (name: string) => {
      await page.screenshot({ path: info.outputPath(`${name}-${mode}.png`) });
      await expectReadableSpacing(page);
      const dialog = page.getByRole("dialog");
      if (await dialog.count()) {
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await dialog.getByRole("button", { name: "닫기", exact: true }).click();
      }
    };
    await page.getByRole("button", { name: "시작", exact: true }).click();
    await capture("home");
    await settings(page, "포트 포워딩");
    await capture("tunnel-list");
    await page.getByRole("button", { name: "새 규칙", exact: true }).click();
    await capture("tunnel-dialog");
    await settings(page, "로컬 터미널");
    await page.getByRole("button", { name: "추가", exact: true }).click();
    await capture("profile-dialog");
    await settings(page, "인증 프로필");
    await page
      .getByRole("button", { name: "프로필 등록", exact: true })
      .click();
    await page.getByRole("dialog").locator("select").selectOption("key");
    await capture("credential-dialog");
    await settings(page, "외형");
    await page.getByRole("tab", { name: "테마", exact: true }).click();
    await page
      .getByRole("button", { name: "현재 테마에서 만들기", exact: true })
      .click();
    await capture("theme-dialog");
    await settings(page, "단축키");
    await page
      .getByRole("button", { name: "출력 검색 키 변경", exact: true })
      .click();
    await capture("shortcut-dialog");
    await page.getByRole("button", { name: "알림함", exact: true }).click();
    await expect(page.locator(".activity-view .empty")).toBeVisible();
    await capture("activity-empty");
  }
});

test.afterEach(async () => {
  await suite.application.evaluate(() => {
    delete (globalThis as any).__shortcutIO;
  });
});
