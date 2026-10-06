import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";
import { bundledFonts } from "../../src/shared/fonts";

let application: ElectronApplication, page: Page;
const suite = reusableApp({ name: "experience" });
test.beforeEach(async () => {
  application = suite.application;
  page = suite.page;

  await expect(
    page.getByRole("button", { name: "새 로컬 터미널", exact: true }),
  ).toBeVisible();
});

const mod = process.platform === "darwin" ? "Meta" : "Control";
const connected = (target: Page) =>
  expect(target.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );

test("local shortcuts create independent windows exactly once and preserve existing terminals", async () => {
  await page.keyboard.press(`${mod}+n`);
  await connected(page);
  const first = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  const firstPane = first.document.workspaces[0].root.id;
  const firstSession = first.sessionStates.find(
    (state) => state.id === firstPane,
  )?.environment?.sessionInstanceId;
  await page.keyboard.press(`${mod}+n`);
  await connected(page);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.workspaces.length,
    )
    .toBe(2);
  const created = application.waitForEvent("window");
  await page.keyboard.press(`${mod}+Shift+n`);
  const second = await created;
  await connected(second);
  const next = await second.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  expect(next.document.workspaces).toHaveLength(3);
  expect(
    Object.values(next.workspaceOwners).filter(
      (owner) => owner === next.windowId,
    ),
  ).toHaveLength(1);
  expect(
    next.sessionStates.find((state) => state.id === firstPane)?.environment
      ?.sessionInstanceId,
  ).toBe(firstSession);
  await second.locator(".xterm-helper-textarea").focus();
  await second.keyboard.type(
    process.platform === "win32"
      ? "echo NEW_WINDOW_READY"
      : "printf 'NEW_WINDOW_%s\\n' READY",
  );
  await second.keyboard.press("Enter");
  await expect(second.locator(".xterm-rows")).toContainText("NEW_WINDOW_READY");
  await second.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "N",
        shiftKey: true,
        metaKey: navigator.platform.includes("Mac"),
        ctrlKey: !navigator.platform.includes("Mac"),
        repeat: true,
        bubbles: true,
      }),
    ),
  );
  expect(await application.windows()).toHaveLength(2);
  // Two nearly simultaneous callers append against main's current document.
  await Promise.all([
    page.evaluate(() => window.passport.call("terminal.create", undefined)),
    second.evaluate(() => window.passport.call("terminal.create", undefined)),
  ]);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.workspaces.length,
    )
    .toBe(5);
  // Unconnected fixtures exercise the shared limit without launching 32 shells.
  await page.evaluate(async () => {
    const { document } = await window.passport.call("bootstrap", undefined);
    while (document.workspaces.length < 32)
      document.workspaces.push({
        id: crypto.randomUUID(),
        name: "limit fixture",
        root: {
          kind: "pane",
          id: crypto.randomUUID(),
          hostId: "00000000-0000-4000-8000-000000000001",
          local: { shell: document.settings.terminal.shell, cwd: "" },
        },
      });
    await window.passport.call("save", document);
  });
  const limit = await page.evaluate(() =>
    window.passport.call("window.create", undefined).then(
      () => "unexpected success",
      (error) => error.message,
    ),
  );
  expect(limit).toContain("32개");
  expect(await application.windows()).toHaveLength(2);
  for (const state of next.sessionStates.filter(
    (state) =>
      next.workspaceOwners[
        next.document.workspaces.find(
          (workspace) => workspace.root.id === state.id,
        )?.id || ""
      ] === next.windowId,
  ))
    await second.evaluate(
      (id) => window.passport.call("session.close", { id }),
      state.id,
    );
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(),
    next.windowId,
  );
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("window.list", undefined),
          )
        ).length,
    )
    .toBe(1);
  expect(
    (
      await page.evaluate(() => window.passport.call("bootstrap", undefined))
    ).sessionStates.find((state) => state.id === firstPane)?.status,
  ).toBe("connected");
});

test("terminal alert acknowledgements validate ownership and native focus without displaying windows", async () => {
  await page.keyboard.press(`${mod}+n`);
  await connected(page);
  const first = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).document.workspaces[0].root.id;
  await page.keyboard.press(`${mod}+n`);
  await connected(page);
  const boot = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  const second = boot.document.workspaces[1].root.id;
  await page.evaluate(async (document) => {
    document.settings.notifications.desktop = "off";
    await window.passport.call("save", document);
  }, boot.document);
  // Inject only the window-state query. This exercises the real IPC/service/DB
  // path while keeping actual native show/focus events at zero.
  const focused = (value: boolean) =>
    application.evaluate(
      ({ BrowserWindow }, { id, value }) => {
        const win = BrowserWindow.fromId(id)!;
        win.isFocused = () => value;
        win.isVisible = () => true;
      },
      { id: boot.windowId, value },
    );
  await focused(false);
  for (const id of [first, second])
    await page.evaluate(
      (id) =>
        window.passport.call("session.input", {
          id,
          data: "node -e \"process.stdout.write(String.fromCharCode(27)+']9;attention'+String.fromCharCode(7))\"\r",
        }),
      id,
    );
  const rows = () =>
    page.evaluate(() => window.passport.call("activity.list", undefined));
  await expect.poll(async () => (await rows()).length).toBe(2);
  await page.evaluate(
    (paneId) => window.passport.call("activity.focus", { paneId }),
    first,
  );
  expect((await rows()).filter((row) => !row.read)).toHaveLength(2);
  await focused(true);
  await page.evaluate(
    (paneId) => window.passport.call("activity.focus", { paneId }),
    first,
  );
  expect((await rows()).find((row) => row.paneId === first)?.read).toBe(true);
  expect((await rows()).find((row) => row.paneId === second)?.read).toBe(false);
  const invalid = await page.evaluate(() =>
    window.passport
      .call("activity.focus", { paneId: crypto.randomUUID() })
      .then(
        () => "accepted",
        (error) => error.message,
      ),
  );
  expect(invalid).toContain("이 창에 속한");
  await page.evaluate(() =>
    window.passport.call("activity.focus", { paneId: null }),
  );
  expect((await rows()).filter((row) => !row.read)).toHaveLength(1);
  await page.getByRole("button", { name: "알림함", exact: true }).click();
  await expect(page.locator(".activity-row")).toHaveCount(2);
  await page.getByRole("button", { name: "모두 읽음", exact: true }).click();
  await expect
    .poll(async () => (await rows()).filter((row) => !row.read).length)
    .toBe(0);
  await expect(page.locator(".activity-row")).toHaveCount(2);
});

test("bundled terminal fonts load offline and preserve settings and aligned output", async ({}, info) => {
  const remoteFonts: string[] = [];
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      /\.(woff2?|ttf)(\?|$)/.test(request.url())
    )
      remoteFonts.push(request.url());
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "터미널 설정", exact: true }).click();
  const picker = page.locator(".font-picker");
  await expect(picker.locator('optgroup[label="앱 내장"] option')).toHaveCount(
    7,
  );
  for (const family of bundledFonts) {
    await picker.getByLabel("글꼴 검색", { exact: true }).fill(family);
    await picker.getByLabel("글꼴", { exact: true }).selectOption(family);
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.passport.call("bootstrap", undefined),
            )
          ).document.settings.appearance.font,
      )
      .toBe(family);
    const loaded = await page.evaluate(async (family) => {
      const normal = await document.fonts.load(
        `400 14px ${JSON.stringify(family)}`,
        "MWil01 한글 ┌─┐",
      );
      const bold = await document.fonts.load(
        `700 14px ${JSON.stringify(family)}`,
        "MWil01 한글 ┌─┐",
      );
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `14px ${JSON.stringify(family)}`;
      return {
        normal: normal.length,
        bold: bold.length,
        difference: Math.abs(
          context.measureText("iiii0000").width -
            context.measureText("WWWW0000").width,
        ),
      };
    }, family);
    expect(loaded.normal).toBeGreaterThan(0);
    expect(loaded.bold).toBeGreaterThan(0);
    expect(loaded.difference).toBeLessThan(0.1);
  }
  const hangul = await page.evaluate(async () => {
    await document.fonts.load('14px "D2Coding"', "한글 ┌─┐");
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = '14px "D2Coding"';
    return Math.abs(
      context.measureText("한글").width - context.measureText("1234").width,
    );
  });
  expect(hangul).toBeLessThan(0.1);
  await page.evaluate(async () => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.settings.appearance.font = "Absent Passport Mono";
    await window.passport.call("save", document);
  });
  await expect(picker.getByRole("status")).toContainText("JetBrains Mono");
  await picker.getByLabel("글꼴", { exact: true }).selectOption("D2Coding");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.settings.appearance.font,
    )
    .toBe("D2Coding");
  await page.screenshot({ path: info.outputPath("font-picker.png") });
  await page.reload();
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await connected(page);
  const boot = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  expect(boot.document.settings.appearance.font).toBe("D2Coding");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    process.platform === "win32"
      ? "echo FONT_READY"
      : "printf 'FONT_%s\\n' READY",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("FONT_READY");
  await expect(page.locator(".xterm-rows")).toHaveCSS(
    "font-family",
    /D2Coding/,
  );
  await page.keyboard.type(
    "node -e \"console.log(String.fromCodePoint(0xd55c,0xae00)+' 123 '+String.fromCodePoint(0x250c,0x2500,0x2510))\"",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("한글 123 ┌─┐");
  await page.screenshot({ path: info.outputPath("terminal-font.png") });
  expect(remoteFonts).toEqual([]);
});

test("viewing a foreground terminal reads only its alerts and preserves history @desktop", async () => {
  await page.keyboard.press(`${mod}+n`);
  await connected(page);
  const first = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).document.workspaces[0];
  await page.keyboard.press(`${mod}+n`);
  await connected(page);
  const boot = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  await page.evaluate(async (document) => {
    document.settings.notifications.desktop = "off";
    await window.passport.call("save", document);
  }, boot.document);
  // Use the same Node command in POSIX shells, cmd and PowerShell.
  const send = (paneId: string) =>
    page.evaluate(
      (id) =>
        window.passport.call("session.input", {
          id,
          data: "node -e \"process.stdout.write(String.fromCharCode(27)+']9;attention'+String.fromCharCode(7))\"\r",
        }),
      paneId,
    );
  await send(first.root.id);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("activity.list", undefined),
          )
        ).filter((row) => !row.read).length,
    )
    .toBe(1);
  await page.evaluate(async (paneId) => {
    const item = (await window.passport.call("activity.list", undefined)).find(
      (row) => row.paneId === paneId,
    )!;
    await window.passport.call("activity.open", { id: item.id });
  }, first.root.id);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("activity.list", undefined),
          )
        ).filter((row) => !row.read).length,
    )
    .toBe(0);
  expect(
    await page.evaluate(() => window.passport.call("activity.list", undefined)),
  ).toHaveLength(1);
});
