import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";

let application: ElectronApplication, page: Page, paneId: string;
const errors: string[] = [];
const destination =
  "https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules";

const suite = reusableApp({ name: "links" });
test.beforeEach(async () => {
  application = suite.application;
  page = suite.page;
  errors.length = 0;

  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
    "1 / 1 연결",
  );
  paneId = await page.evaluate(async () => {
    const boot = await window.passport.call("bootstrap", undefined);
    return boot.document.workspaces[0].root.id;
  });
  // Keep the pane and its scrollback, but stop the shell before injecting output.
  await page.evaluate(
    (id) => window.passport.call("session.close", { id }),
    paneId,
  );
  await application.evaluate(({ dialog, shell }) => {
    const state = globalThis as any;
    state.__links = { opened: [], prompts: [], response: 0, fail: false };
    dialog.showMessageBox = async (_parent: unknown, options?: unknown) => {
      state.__links.prompts.push(options);
      return { response: state.__links.response, checkboxChecked: false };
    };
    shell.openExternal = async (url) => {
      if (state.__links.fail) throw new Error("테스트 브라우저 실행 실패");
      state.__links.opened.push(url);
    };
  });
});

test.afterEach(() => expect(errors).toEqual([]));

const state = () => application.evaluate(() => (globalThis as any).__links);
type LinkPosition = { x: number; y: number };

async function showLink(url: string, label: string) {
  return showOutput(
    `\r\n\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\\r\n`,
    label,
  );
}

async function showOutput(data: string, label: string | RegExp) {
  await application.evaluate(
    ({ BrowserWindow }, { id, data }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("passport:event", {
        kind: "output",
        id,
        data,
        bytes: 0,
      });
    },
    { id: paneId, data },
  );
  const link = page
    .locator(".xterm-rows")
    .getByText(label, { exact: true })
    .first();
  await expect(link).toBeVisible();
  // Capture cell coordinates before hover decoration replaces these spans.
  // Both rectangles are read in the same renderer task, without CDP DOM races.
  let position: LinkPosition | undefined;
  await expect
    .poll(async () => {
      position = await link.evaluate((element) => {
        const screen = element.closest(".xterm-screen");
        if (!screen || !element.isConnected) return undefined;
        const target = element.getBoundingClientRect();
        const origin = screen.getBoundingClientRect();
        if (!target.width || !target.height) return undefined;
        return {
          x: target.x - origin.x + target.width / 2,
          y: target.y - origin.y + target.height / 2,
        };
      });
      return position;
    })
    .toBeDefined();
  return position!;
}

async function clickLink(position: LinkPosition) {
  // Hover decoration replaces xterm's display spans. Target the stable screen
  // at the link's cell position; the spans themselves have pointer-events:none.
  const screen = page.locator(".view:not([hidden]) .xterm-screen");
  // Leave the link first so repeated clicks refresh xterm's hover cache.
  await screen.hover({ position: { x: 2, y: 2 } });
  await screen.hover({ position });
  await expect(screen).toHaveClass(/xterm-cursor-pointer/);
  await screen.click({ position });
}

test("terminal hyperlinks confirm the actual URL and open the browser without navigating the app", async () => {
  // The native xterm fallback would show the English JS dialog in the report.
  const browserDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    browserDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const originalURL = page.url();
  const link = await showLink(destination, "Electron documentation");
  await clickLink(link);
  await expect.poll(async () => (await state()).prompts.length).toBe(1);
  expect((await state()).opened).toEqual([]);
  expect((await state()).prompts[0]).toMatchObject({
    title: "링크 열기",
    detail: destination,
    buttons: ["취소", "브라우저에서 열기"],
    cancelId: 0,
  });

  await application.evaluate(() => {
    (globalThis as any).__links.response = 1;
  });
  await clickLink(link);
  await expect.poll(async () => (await state()).opened).toEqual([destination]);

  const localURL =
    "http://localhost:3000/callback?code=a%20b&state=123#complete";
  const localLink = await showLink(localURL, "Local callback");
  await clickLink(localLink);
  await expect
    .poll(async () => (await state()).opened)
    .toEqual([destination, localURL]);
  expect(browserDialogs).toEqual([]);
  expect(page.url()).toBe(originalURL);
  expect(await application.windows()).toHaveLength(1);

  await application.evaluate(() => {
    (globalThis as any).__links.fail = true;
  });
  await clickLink(localLink);
  await expect(
    page.getByText("테스트 브라우저 실행 실패", { exact: true }),
  ).toBeVisible();
});

test("plain terminal URLs in tables and wrapped lines open their exact web destinations", async () => {
  const originalURL = page.url();
  const plainURL = "https://example.com/docs?q=one%20two#result";
  const plainLink = await showOutput(`\r\n${plainURL}\r\n`, plainURL);
  await clickLink(plainLink);
  await expect.poll(async () => (await state()).prompts.length).toBe(1);
  expect((await state()).prompts[0].detail).toBe(plainURL);
  expect((await state()).opened).toEqual([]);

  await application.evaluate(() => {
    (globalThis as any).__links.response = 1;
  });
  await clickLink(plainLink);
  await expect.poll(async () => (await state()).opened).toEqual([plainURL]);

  const tableURL = "http://127.0.0.1:20080/team/script/-/merge_requests/18";
  const tableLink = await showOutput(
    `\r\n│ 스크립트 │ a710111 │ !18 (\x1b[36m${tableURL}\x1b[0m) │\r\n`,
    tableURL,
  );
  await clickLink(tableLink);
  await expect
    .poll(async () => (await state()).opened)
    .toEqual([plainURL, tableURL]);
  expect((await state()).prompts.at(-1).detail).toBe(tableURL);

  const wrappedURL = `https://example.com/${"x".repeat(350)}?query=yes#end`;
  const wrappedLink = await showOutput(
    `\x1b[2J\x1b[H${wrappedURL}\r\n`,
    /^x+$/,
  );
  // Click a continuation row containing only the path, without the scheme.
  await clickLink(wrappedLink);
  await expect
    .poll(async () => (await state()).opened)
    .toEqual([plainURL, tableURL, wrappedURL]);
  expect((await state()).prompts.at(-1).detail).toBe(wrappedURL);

  // An explicit hyperlink keeps its destination even if its label is a URL.
  const explicitLink = await showLink(destination, "https://example.com/label");
  await clickLink(explicitLink);
  await expect
    .poll(async () => (await state()).opened)
    .toEqual([plainURL, tableURL, wrappedURL, destination]);
  expect((await state()).prompts.at(-1).detail).toBe(destination);
  expect(page.url()).toBe(originalURL);
  expect(await application.windows()).toHaveLength(1);
});

test("terminal link IPC rejects unsafe destinations and panes owned by another window", async () => {
  for (const url of [
    "file:///tmp/passport-link",
    "javascript:alert(1)",
    "ms-settings:notifications",
    "https://trusted.example@elsewhere.example/",
    "https://example.com/\nfile.exe",
  ]) {
    const error = await page.evaluate(
      async ({ id, url }) => {
        try {
          await window.passport.call("terminal.link", { id, url });
        } catch (error) {
          return String(error);
        }
      },
      { id: paneId, url },
    );
    expect(error).toBeTruthy();
  }
  const created = application.waitForEvent("window");
  await page.evaluate(() => window.passport.call("window.create", undefined));
  const second = await created;
  await second.waitForSelector(".app");
  const error = await second.evaluate(
    async ({ id, url }) => {
      try {
        await window.passport.call("terminal.link", { id, url });
      } catch (error) {
        return String(error);
      }
    },
    { id: paneId, url: destination },
  );
  expect(error).toContain("이 창에 속한 터미널이 아닙니다.");
  expect((await state()).opened).toEqual([]);
  expect((await state()).prompts).toEqual([]);
});
