import { test, expect, type Page } from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";
import { waitForLocalPrompt } from "../fixtures/terminal-ready";
import type { ShareSnapshot } from "../../src/shared/share";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";

const suite = reusableApp({ name: "terminal-menu" });
const selection = "MENU_FIRST  alpha\nMENU_SECOND beta";
const copiedSelection =
  process.platform === "win32" ? selection.replaceAll("\n", "\r\n") : selection;
const terminal = (page: Page) =>
  page.locator(".view:not([hidden]) .terminal-surface");
const menu = (page: Page) =>
  page.getByRole("menu", { name: "터미널 메뉴", exact: true });

async function setup() {
  const { page, application } = suite;
  await application.evaluate(
    ({ ipcMain, clipboard, dialog, BrowserWindow }) => {
      const g = globalThis as any;
      g.__menuShare = {
        settings: { enabled: false },
        peers: [],
        requests: [],
        transfers: [],
        messages: [],
        nearby: [],
        interfaces: [],
      };
      g.__menuCopied = "untouched";
      g.__menuSends = [];
      g.__menuHoldSend = false;
      g.__menuSendError = "";
      g.__menuReleaseSend = undefined;
      g.__menuInputs = [];
      clipboard.writeText = async (text) => {
        g.__menuCopied = text;
      };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: ["/fixture/existing.txt"],
      });
      const original = (ipcMain as any)._invokeHandlers.get("passport:call");
      ipcMain.removeHandler("passport:call");
      ipcMain.handle("passport:call", async (event, name, input) => {
        if (name === "share.state") return { ok: true, value: g.__menuShare };
        if (name === "share.send") {
          g.__menuSends.push(input);
          if (g.__menuHoldSend)
            await new Promise<void>((resolve) => {
              g.__menuReleaseSend = resolve;
            });
          return g.__menuSendError
            ? { ok: false, error: g.__menuSendError }
            : {
                ok: true,
                value: { id: "fixture-transfer", state: "preparing" },
              };
        }
        if (name === "clipboard.terminal")
          return { ok: true, value: { kind: "text", text: "MENU_PASTE" } };
        if (name === "session.input") g.__menuInputs.push(input);
        if (name === "session.paste")
          g.__menuInputs.push({ ...input, data: input.text });
        return original(event, name, input);
      });
      BrowserWindow.getAllWindows()[0].webContents.send("passport:event", {
        kind: "share-changed",
      });
    },
  );
  const target = await page.evaluate(async () => {
    const b = await window.passport.call("bootstrap", undefined);
    b.document.settings.terminal.shell =
      b.platform === "win32" ? "passport-bash" : "zsh";
    b.document.settings.sessionResume = false;
    await window.passport.call("save", b.document);
    const target = await window.passport.call("terminal.create", undefined);
    const next = await window.passport.call("bootstrap", undefined);
    const workspace = next.document.workspaces.find(
      (w) => w.id === target.workspaceId,
    )!;
    if (workspace.root.kind !== "pane") throw new Error("Expected pane");
    await window.passport.call("session.connect", {
      id: target.paneId,
      hostId: workspace.root.hostId,
    });
    return { ...target, name: workspace.name };
  });
  await page.getByRole("button", { name: target.name, exact: true }).click();
  await expect(terminal(page)).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).sessionStates.find((s) => s.id === target.paneId)?.environment
          ?.status,
    )
    .toBe("ready");
  await waitForLocalPrompt(page);
  return target;
}

async function output(id: string, text: string) {
  const generation = await suite.page.evaluate(
    async (id) =>
      (await window.passport.call("bootstrap", undefined)).sessionStates.find(
        (s) => s.id === id,
      )!.generation!,
    id,
  );
  await suite.application.evaluate(
    ({ BrowserWindow }, { id, text, generation }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("passport:event", {
        kind: "output",
        id,
        generation,
        data: text,
        bytes: 0,
      });
    },
    { id, text, generation },
  );
}
async function selectText(
  id: string,
  write = (text: string) => output(id, text),
) {
  const page = suite.page;
  await write("\x1b[2J\x1b[H" + selection.replaceAll("\n", "\r\n"));
  const rows = terminal(page).locator(".xterm-rows > div");
  await expect(rows.nth(0)).toHaveText("MENU_FIRST  alpha");
  let cell = 0;
  await expect
    .poll(async () => {
      cell = await rows.nth(0).evaluate((row) => {
        const span = [...row.querySelectorAll("span")].find((s) =>
          s.textContent?.includes("MENU_FIRST"),
        );
        return span
          ? span.getBoundingClientRect().width / span.textContent!.length
          : 0;
      });
      return cell;
    })
    .toBeGreaterThan(0);
  const first = await rows.nth(0).boundingBox();
  const last = await rows.nth(1).boundingBox();
  await page.mouse.move(first!.x + 1, first!.y + first!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    last!.x + cell * "MENU_SECOND beta".length + 1,
    last!.y + last!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
}
async function openMenu() {
  const surface = terminal(suite.page);
  await surface.click({ button: "right", position: { x: 20, y: 12 } });
  await expect(menu(suite.page)).toBeVisible();
}
async function shareState(change: Partial<ShareSnapshot>) {
  await suite.application.evaluate(({ BrowserWindow }, change) => {
    Object.assign((globalThis as any).__menuShare, change);
    BrowserWindow.getAllWindows()[0].webContents.send("passport:event", {
      kind: "share-changed",
    });
  }, change);
}
async function enableFriends() {
  await shareState({
    settings: { enabled: true } as ShareSnapshot["settings"],
    endpoint: { address: "127.0.0.1", port: 12345 },
    peers: [
      {
        id: "friend-a",
        name: "지수",
        endpoint: { address: "127.0.0.1", port: 12345 },
      },
      {
        id: "friend-b",
        name: "승민",
        endpoint: { address: "127.0.0.1", port: 12346 },
      },
    ],
  });
}
async function choose(name: string) {
  await menu(suite.page).getByRole("menuitem", { name: "바로 보내기" }).hover();
  await suite.page
    .getByRole("menu", { name: "쪽지 받을 친구" })
    .getByRole("menuitem", { name })
    .click();
}
async function compose() {
  await menu(suite.page).getByRole("menuitem", { name: "쪽지로 작성" }).click();
}
async function recipient(name: string) {
  await suite.page
    .getByRole("combobox", { name: "받는 사람", exact: true })
    .click();
  await suite.page.getByRole("option", { name: new RegExp(name) }).click();
}

test("terminal menus preserve selected text, target paste and expose sharing availability with keyboard navigation", async ({}, info) => {
  const { page, application } = suite;
  const target = await setup();
  await openMenu();
  await expect(
    menu(page).getByRole("menuitem", { name: "복사", exact: true }),
  ).toBeDisabled();
  await expect(
    menu(page).getByRole("menuitem", { name: "바로 보내기" }),
  ).toBeDisabled();
  await expect(
    menu(page).getByRole("menuitem", { name: "쪽지로 작성" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await selectText(target.paneId);
  await openMenu();
  expect(
    await application.evaluate(() => (globalThis as any).__menuCopied),
  ).toBe("untouched");
  await menu(page).getByRole("menuitem", { name: "복사", exact: true }).click();
  expect(
    await application.evaluate(() => (globalThis as any).__menuCopied),
  ).toBe(copiedSelection);
  await openMenu();
  await menu(page).getByRole("menuitem", { name: "바로 보내기" }).hover();
  await expect(
    page.getByRole("menu", { name: "쪽지 받을 친구" }),
  ).toContainText("쪽지를 켜 주세요");
  await shareState({
    settings: { enabled: true } as ShareSnapshot["settings"],
    endpoint: { address: "127.0.0.1", port: 12345 },
  });
  await expect(
    page.getByRole("menu", { name: "쪽지 받을 친구" }),
  ).toContainText("등록된 친구가 없습니다");
  await expect(
    menu(page).getByRole("menuitem", { name: "쪽지로 작성" }),
  ).toBeEnabled();
  await enableFriends();
  await expect(
    page.getByRole("menu", { name: "쪽지 받을 친구" }).getByRole("menuitem"),
  ).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("terminal-menu.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await terminal(page).locator("textarea").press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    menu(page).getByRole("menuitem", { name: "쪽지로 작성" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menuitem", { name: "지수" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    menu(page).getByRole("menuitem", { name: "바로 보내기" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await openMenu();
  await menu(page).getByRole("menuitem", { name: "붙여넣기" }).click();
  await expect
    .poll(
      async () =>
        (
          await application.evaluate(() => (globalThis as any).__menuInputs)
        ).filter((i: { data: string }) => i.data.includes("MENU_PASTE")).length,
    )
    .toBe(1);
  const input = (
    await application.evaluate(() => (globalThis as any).__menuInputs)
  ).find((i: { data: string }) => i.data.includes("MENU_PASTE"));
  expect(input.id).toBe(target.paneId);
  expect(input.data).not.toMatch(/[\r\n]/);
});

test("terminal quick send sends once without opening or replacing drafts and reports request failures", async () => {
  const { page, application } = suite;
  const target = await setup();
  await enableFriends();
  await selectText(target.paneId);
  await openMenu();
  await compose();
  const editor = page.getByRole("textbox", {
    name: "Markdown 쪽지",
    exact: true,
  });
  await recipient("지수");
  await editor.fill("보존할 초안");
  await page.getByRole("button", { name: "파일 선택", exact: true }).click();
  await page.getByRole("button", { name: target.name, exact: true }).click();
  await selectText(target.paneId);
  await openMenu();
  await output(target.paneId, "\x1b[2J\x1b[HOUTPUT_CHANGED");
  await expect(terminal(page)).toContainText("OUTPUT_CHANGED");
  await application.evaluate(() => {
    (globalThis as any).__menuHoldSend = true;
  });
  try {
    await choose("승민");
    await expect
      .poll(() => application.evaluate(() => (globalThis as any).__menuSends))
      .toEqual([{ to: "friend-b", text: copiedSelection }]);
    await expect(terminal(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(editor).not.toBeVisible();
    await selectText(target.paneId);
    await openMenu();
    await menu(page).getByRole("menuitem", { name: "바로 보내기" }).hover();
    await expect(
      page.getByRole("menu", { name: "쪽지 받을 친구" }),
    ).toContainText("쪽지 전송을 준비 중입니다.");
    await expect(
      page.getByRole("menu", { name: "쪽지 받을 친구" }).getByRole("menuitem"),
    ).toHaveCount(0);
  } finally {
    await application.evaluate(() => {
      const g = globalThis as any;
      g.__menuHoldSend = false;
      g.__menuReleaseSend?.();
      g.__menuReleaseSend = undefined;
    });
  }
  await expect(page.locator(".toast")).toContainText(
    "승민님에게 쪽지 전송을 요청했습니다.",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await application.evaluate(() => {
    (globalThis as any).__menuSendError = "쪽지가 꺼져 있습니다.";
  });
  await openMenu();
  await choose("승민");
  await expect(page.locator(".toast.error")).toContainText(
    "쪽지가 꺼져 있습니다.",
  );
  await expect(terminal(page)).toBeVisible();
  await page.locator('.app-tab[aria-label="쪽지"]').click();
  await page.getByRole("tab", { name: "보내기", exact: true }).click();
  await expect(editor).toHaveValue("보존할 초안");
  await expect(
    page.getByRole("combobox", { name: "받는 사람", exact: true }),
  ).toHaveValue("지수");
  await expect(page.locator(".share-attachment")).toContainText("existing.txt");
  expect(
    await application.evaluate(() => (globalThis as any).__menuSends),
  ).toEqual([
    { to: "friend-b", text: copiedSelection },
    { to: "friend-b", text: copiedSelection },
  ]);
  expect(
    await application.evaluate(() => (globalThis as any).__menuCopied),
  ).toBe("untouched");
});

test("terminal sharing prefills a draft without sending and requires discard or cancel for existing text and attachments", async ({}, info) => {
  const { page, application } = suite;
  const target = await setup();
  await enableFriends();
  await selectText(target.paneId);
  await openMenu();
  await output(target.paneId, "\x1b[2J\x1b[HOUTPUT_CHANGED");
  await expect(terminal(page)).toContainText("OUTPUT_CHANGED");
  await compose();
  const editor = page.getByRole("textbox", {
    name: "Markdown 쪽지",
    exact: true,
  });
  await expect(editor).toHaveValue(selection);
  await expect(
    page.getByRole("combobox", { name: "받는 사람", exact: true }),
  ).toHaveValue("");
  await recipient("지수");
  expect(
    await application.evaluate(() => (globalThis as any).__menuSends),
  ).toEqual([]);
  expect(
    await application.evaluate(() => (globalThis as any).__menuCopied),
  ).toBe("untouched");
  await editor.fill("작성 중인 원문\n```nested```\n");
  await page.getByRole("button", { name: "파일 선택", exact: true }).click();
  await expect(page.locator(".share-attachment")).toContainText("existing.txt");
  await page.getByRole("button", { name: target.name, exact: true }).click();
  await selectText(target.paneId);
  await openMenu();
  await compose();
  const dialog = page.getByRole("dialog", {
    name: "작성 중인 쪽지",
    exact: true,
  });
  await expect(dialog).toContainText(
    "작성 중인 쪽지가 있습니다. 버리고 새로 작성하시겠습니까?",
  );
  await page.screenshot({ path: info.outputPath("discard-or-cancel.png") });
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(editor).toHaveValue("작성 중인 원문\n```nested```\n");
  await expect(
    page.getByRole("combobox", { name: "받는 사람", exact: true }),
  ).toHaveValue("지수");
  await expect(page.locator(".share-attachment")).toContainText("existing.txt");
  await page.getByRole("button", { name: target.name, exact: true }).click();
  await selectText(target.paneId);
  await openMenu();
  await compose();
  await dialog.getByRole("button", { name: "버리기", exact: true }).click();
  await expect(editor).toHaveValue(selection);
  await expect(
    page.getByRole("combobox", { name: "받는 사람", exact: true }),
  ).toHaveValue("");
  await expect(page.locator(".share-attachment")).toHaveCount(0);
  await page.getByRole("button", { name: "코드 블록으로 감싸기" }).click();
  await expect(editor).toHaveValue("```\n" + selection + "\n```");
  expect(
    await application.evaluate(() => (globalThis as any).__menuSends),
  ).toEqual([]);
  await recipient("승민");
  await page.getByRole("button", { name: "쪽지 보내기", exact: true }).click();
  expect(
    await application.evaluate(() => (globalThis as any).__menuSends),
  ).toEqual([{ to: "friend-b", text: "```\n" + copiedSelection + "\n```" }]);
  await expect(editor).toHaveValue("");
});

test("SSH terminal menus preserve mouse reporting and fit at the window edge", async () => {
  const { page } = suite;
  await setup();
  await enableFriends();
  const server = await sshFixture(suite.directory);
  const id = crypto.randomUUID();
  try {
    const host = hostSchema.parse({
      id: crypto.randomUUID(),
      name: "메뉴 SSH",
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
    });
    await page.evaluate(
      async ({ host, id }) => {
        const { document } = await window.passport.call("bootstrap", undefined);
        document.settings.confirmNewHostKeys = false;
        document.hosts.push(host);
        document.workspaces.push({
          id: crypto.randomUUID(),
          name: host.name,
          root: { kind: "pane", id, hostId: host.id },
        });
        await window.passport.call("save", document);
        await window.passport.call("session.connect", {
          id,
          hostId: host.id,
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        });
      },
      { host, id },
    );
    await page.getByRole("button", { name: host.name, exact: true }).click();
    await expect.poll(() => server.shells.length).toBe(1);
    server.shells[0].write("\x1b[?1000h\x1b[?1006h\r\nMOUSE_READY");
    await expect(terminal(page)).toContainText("MOUSE_READY");
    const before = server.input.length;
    await terminal(page).click({ button: "right", position: { x: 40, y: 45 } });
    await expect(menu(page)).toHaveCount(0);
    await expect
      .poll(() => server.input.slice(before).join(""))
      .toContain("\x1b[<2;");
    const after = server.input.length;
    await page.keyboard.down("Shift");
    await openMenu();
    await page.keyboard.up("Shift");
    expect(server.input.length).toBe(after);
    await page.keyboard.press("Escape");
    server.shells[0].write("\x1b[?1000l\x1b[?1006l");
    await selectText(id, async (text) => {
      server.shells[0].write(text);
    });
    const bounds = await terminal(page).boundingBox();
    await terminal(page).click({
      button: "right",
      position: {
        x: bounds!.width - 4,
        y: bounds!.height - 4,
      },
    });
    await menu(page).getByRole("menuitem", { name: "바로 보내기" }).hover();
    for (const item of [
      menu(page),
      page.getByRole("menu", { name: "쪽지 받을 친구" }),
    ]) {
      const rect = await item.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.getByRole("menuitem", { name: "지수" }).click();
    await expect(terminal(page)).toBeVisible();
    await expect
      .poll(() =>
        suite.application.evaluate(() => (globalThis as any).__menuSends),
      )
      .toEqual([{ to: "friend-a", text: copiedSelection }]);
  } finally {
    await page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      id,
    );
    await server.close();
  }
});
