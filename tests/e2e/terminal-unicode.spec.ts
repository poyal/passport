import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reusableApp } from "../fixtures/reusable-app";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";

const startup = path.join(os.tmpdir(), `passport-unicode-${randomUUID()}`);
test.beforeAll(async () => {
  await fs.mkdir(startup, { recursive: true });
  await fs.writeFile(
    path.join(startup, ".zshrc"),
    `
HISTFILE=/dev/null
PROMPT='SIK XX > '
RPROMPT=''
bindkey -e
_passport_capture() {
  printf '%s\\0%s\\0' "$BUFFER" "$COLUMNS" >| "$ZDOTDIR/capture.tmp"
  /bin/mv -f "$ZDOTDIR/capture.tmp" "$ZDOTDIR/capture"
}
zle -N _passport_capture
bindkey '^G' _passport_capture
print -r -- UNICODE_SHELL_READY
`,
  );
});
const suite = reusableApp({
  name: "unicode",
  env: { ZDOTDIR: startup, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
});
test.afterAll(async () => fs.rm(startup, { recursive: true, force: true }));

test("macOS zsh edits wrapped emoji prompts and pasted Unicode without stale text", async ({}, info) => {
  test.skip(process.platform !== "darwin", "Requires macOS zsh.");
  const { page, application } = suite;
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
  );
  await page.evaluate(async (cwd) => {
    const boot = await window.passport.call("bootstrap", undefined);
    Object.assign(boot.document.settings.terminal, {
      shell: "zsh",
      cwd,
      profileIds: [],
    });
    await window.passport.call("save", boot.document);
  }, startup);
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  const id = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).sessionStates[0].id;
  const pane = page.locator(`[data-pane-id="${id}"]`);
  const rows = pane.locator(".xterm-rows");
  const input = pane.locator(".xterm-helper-textarea");
  await expect(rows).toContainText("UNICODE_SHELL_READY");
  await input.focus();
  async function capture() {
    await fs.rm(path.join(startup, "capture"), { force: true });
    await input.press("Control+g");
    let value: string | null = null;
    await expect
      .poll(async () => {
        value = await fs
          .readFile(path.join(startup, "capture"), "utf8")
          .catch(() => null);
        return value !== null;
      })
      .toBe(true);
    const [buffer, columns] = value!.split("\0");
    return { buffer, columns: Number(columns) };
  }
  async function aligned(expected: string) {
    expect((await capture()).buffer).toBe(expected);
    await expect
      .poll(async () => {
        const full = (await rows.locator(":scope > div").allTextContents())
          .map((line) => line.replace(/\u00a0/g, " ").trimEnd())
          .join("");
        return full.slice(full.lastIndexOf(" > ") + 3).trimEnd();
      })
      .toBe(expected);
  }
  const paste = "a" + "💻é한".repeat(30) + "Z";
  const narrowColumns = (await capture()).columns;
  await application.evaluate(({ ipcMain }, text) => {
    const original = (ipcMain as any)._invokeHandlers.get("passport:call");
    ipcMain.removeHandler("passport:call");
    ipcMain.handle("passport:call", (event, name, input) =>
      name === "clipboard.terminal"
        ? { ok: true, value: { kind: "text", text } }
        : original(event, name, input),
    );
  }, paste);
  for (const [name, token] of [
    ["ascii", "XX"],
    ["laptop", "💻"],
    ["wrench", "🔧"],
  ]) {
    expect((await capture()).buffer).toBe("");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
    );
    await expect
      .poll(async () => (await capture()).columns)
      .toBe(narrowColumns);
    await page.evaluate(
      ({ id, token }) =>
        window.passport.call("session.input", {
          id,
          data: `PROMPT='SIK ${token} > '\r`,
        }),
      { id, token },
    );
    const initial = await capture();
    expect(initial.buffer).toBe("");
    await input.press("Control+l");
    const text =
      "a" +
      "abcdefghijklmnopqrstuvwxyz0123456789"
        .repeat(5)
        .slice(0, initial.columns + 20) +
      "Z";
    await input.pressSequentially(text, { delay: 1 });
    await aligned(text);
    await input.press("Control+a");
    await input.press("Delete");
    await input.pressSequentially("X");
    await input.press("Control+e");
    await input.press("Backspace");
    const edited = "X" + text.slice(1, -1);
    await aligned(edited);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 700),
    );
    await expect
      .poll(async () => (await capture()).columns)
      .not.toBe(initial.columns);
    await aligned(edited);
    await input.press("Backspace");
    await aligned(edited.slice(0, -1));
    await input.press("Control+c");
    expect((await capture()).buffer).toBe("");
    await input.press("Control+l");
    await input.press("Meta+v");
    await aligned(paste);
    await input.press("Backspace");
    await aligned(paste.slice(0, -1));
    await page.screenshot({ path: info.outputPath(`${name}-unicode.png`) });
    await input.press("Control+c");
  }
});

test("SSH normal and alternate screens keep emoji cells aligned with cursor addressing", async ({}, info) => {
  const { page, application } = suite;
  const server = await sshFixture(startup);
  const id = randomUUID();
  try {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "Unicode fixture",
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
    });
    await page.evaluate(
      async ({ id, host }) => {
        const boot = await window.passport.call("bootstrap", undefined);
        boot.document.hosts = [host];
        boot.document.workspaces = [
          {
            id: crypto.randomUUID(),
            name: "Unicode SSH",
            root: { kind: "pane", id, hostId: host.id },
          },
        ];
        await window.passport.call("save", boot.document);
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
      { id, host },
    );
    await page
      .getByRole("button", { name: "Unicode SSH", exact: true })
      .click();
    const rows = page.locator(`[data-pane-id="${id}"] .xterm-rows`);
    await expect(rows).toContainText("테스트 서버에 연결되었습니다.");
    await expect.poll(() => server.shells.length).toBe(1);
    const firstLine = async () =>
      (await rows.locator(":scope > div").first().textContent())?.trimEnd();
    server.shells[0].write("\x1b[2J\x1b[HA💻B\x1b[1;4HZ");
    await expect.poll(firstLine).toBe("A💻Z");
    server.shells[0].write("\x1b[?1049h\x1b[2J\x1b[HA🔧B\x1b[1;4HZ");
    await expect.poll(firstLine).toBe("A🔧Z");
    await page.screenshot({ path: info.outputPath("ssh-alternate.png") });
    server.shells[0].write("\x1b[?1049l");
    await expect.poll(firstLine).toBe("A💻Z");
  } finally {
    try {
      await page.evaluate(
        (id) => window.passport.call("session.close", { id }),
        id,
      );
    } finally {
      await server.close();
    }
  }
});
