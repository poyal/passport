import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reusableApp } from "../fixtures/reusable-app";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";
import {
  pasteTextLimit,
  pasteStart,
  pasteEnd,
} from "../../src/shared/terminal-input";
import { waitForLocalPrompt } from "../fixtures/terminal-ready";

const suite = reusableApp({ name: "large-paste" });
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const body = () => {
  const unit = "한글💻e\u0301";
  return (
    unit.repeat(Math.floor(pasteTextLimit / Buffer.byteLength(unit))) +
    "a".repeat(pasteTextLimit % Buffer.byteLength(unit))
  );
};
const quote = (value: string) =>
  `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

async function setupLocal() {
  const { page } = suite;
  const target = await page.evaluate(async (cwd) => {
    const boot = await window.passport.call("bootstrap", undefined);
    Object.assign(boot.document.settings.terminal, {
      shell: boot.platform === "win32" ? "passport-bash" : "zsh",
      cwd,
      profileIds: [],
    });
    await window.passport.call("save", boot.document);
    const target = await window.passport.call("terminal.create", undefined);
    const next = await window.passport.call("bootstrap", undefined);
    const workspace = next.document.workspaces.find(
      (workspace) => workspace.id === target.workspaceId,
    )!;
    if (workspace.root.kind !== "pane") throw new Error("Expected local pane");
    await window.passport.call("session.connect", {
      id: target.paneId,
      hostId: workspace.root.hostId,
    });
    return { ...target, name: workspace.name };
  }, suite.directory);
  await page.getByRole("button", { name: target.name, exact: true }).click();
  await expect
    .poll(async () => {
      const boot = await page.evaluate(() =>
        window.passport.call("bootstrap", undefined),
      );
      return boot.sessionStates.find((state) => state.id === target.paneId)
        ?.status;
    })
    .toBe("connected");
  const boot = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  const state = boot.sessionStates.find((state) => state.id === target.paneId)!;
  await waitForLocalPrompt(page);
  return state;
}

async function clipboard(text: string) {
  // Only the clipboard read is injected. session.paste, schema, ownership,
  // generation and native/SSH writes all use the product implementation.
  await suite.application.evaluate(({ ipcMain }, text) => {
    const g = globalThis as any;
    g.__largePasteClipboard = text;
    if (g.__largePasteHandler) return;
    const original = (ipcMain as any)._invokeHandlers.get("passport:call");
    g.__largePasteHandler = original;
    ipcMain.removeHandler("passport:call");
    ipcMain.handle("passport:call", (event, name, input) =>
      name === "clipboard.terminal"
        ? { ok: true, value: { kind: "text", text: g.__largePasteClipboard } }
        : original(event, name, input),
    );
  }, text);
}
test.afterEach(async () => {
  await suite.application.evaluate(({ ipcMain }) => {
    const g = globalThis as any;
    if (g.__largePasteHandler) {
      ipcMain.removeHandler("passport:call");
      ipcMain.handle("passport:call", g.__largePasteHandler);
    }
    delete g.__largePasteHandler;
    delete g.__largePasteClipboard;
  });
});

test("4 MiB clipboard paste reaches the local PTY intact and rejects oversize and stale generations", async () => {
  const state = await setupLocal();
  const text = body();
  const expected = pasteStart + text + pasteEnd;
  const receiver = path.join(suite.directory, "receiver.cjs");
  const result = path.join(suite.directory, "received.json");
  await fs.writeFile(
    receiver,
    `
process.stdin.setRawMode(true);
const hash = require('node:crypto').createHash('sha256'); let bytes = 0;
process.stdin.on('data', data => {
  bytes += data.length; hash.update(data);
  if (bytes >= ${Buffer.byteLength(expected)}) {
    require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({ bytes, hash: hash.digest('hex') }));
    process.stdin.removeAllListeners('data'); process.stdin.resume();
    process.stdout.write('RECEIVED\\r\\n');
  }
});
process.stdout.write('\\x1b[?2004hPASTE_READY\\r\\n');
`,
  );
  await suite.page.evaluate(
    ({ id, data }) => window.passport.call("session.input", { id, data }),
    {
      id: state.id,
      data: `${quote(process.execPath)} ${quote(receiver)}\r`,
    },
  );
  const pane = suite.page.locator(`[data-pane-id="${state.id}"]`);
  await expect(pane.locator(".xterm-rows")).toContainText("PASTE_READY");
  await clipboard(text);
  await pane.locator(".xterm-helper-textarea").focus();
  await suite.page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+v",
  );
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(result, "utf8").catch(() => "{}")),
      { timeout: 10000 },
    )
    .toEqual({ bytes: Buffer.byteLength(expected), hash: digest(expected) });
  await expect(pane.locator(".terminal-input-progress")).toHaveCount(0);
  const rejected = await suite.page.evaluate(
    async ({ id, generation, limit }) => {
      const errors: string[] = [];
      for (const input of [
        {
          id,
          sessionInstanceId: generation,
          text: "a".repeat(limit + 1),
          bracketedPaste: true,
        },
        {
          id,
          sessionInstanceId: crypto.randomUUID(),
          text: "stale",
          bracketedPaste: true,
        },
        {
          id: crypto.randomUUID(),
          sessionInstanceId: generation,
          text: "wrong owner",
          bracketedPaste: true,
        },
      ]) {
        try {
          await window.passport.call("session.paste", input);
          errors.push("accepted");
        } catch (error) {
          errors.push((error as Error).message);
        }
      }
      return errors;
    },
    { id: state.id, generation: state.generation!, limit: pasteTextLimit },
  );
  expect(rejected[0]).toContain("4 MiB");
  expect(rejected[1]).toContain("연결이 변경");
  expect(rejected[2]).not.toBe("accepted");
});

test("SSH paste preserves FIFO, cancellation and reconnect isolation while another pane responds", async () => {
  const local = await setupLocal();
  const server = await sshFixture(suite.directory);
  try {
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "paste SSH",
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
    });
    const paneId = randomUUID(),
      workspaceId = randomUUID();
    await suite.page.evaluate(
      async ({ host, paneId, workspaceId }) => {
        const boot = await window.passport.call("bootstrap", undefined);
        boot.document.settings.confirmNewHostKeys = false;
        boot.document.hosts.push(host);
        boot.document.workspaces.push({
          id: workspaceId,
          name: "paste SSH",
          root: { kind: "pane", id: paneId, hostId: host.id },
        });
        await window.passport.call("save", boot.document);
        await window.passport.call("session.connect", {
          id: paneId,
          hostId: host.id,
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        });
      },
      { host, paneId, workspaceId },
    );
    const boot = await suite.page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    const generation = boot.sessionStates.find(
      (state) => state.id === paneId,
    )!.generation!;
    const stream = server.shells[0];
    stream.removeAllListeners("data");
    stream.pause();
    const data: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => data.push(Buffer.from(chunk)));
    const text = body();
    const send = () =>
      suite.page.evaluate(
        (input) => window.passport.call("session.paste", input),
        {
          id: paneId,
          sessionInstanceId: generation,
          text,
          bracketedPaste: true,
        },
      );
    await send();
    await send();
    const move = await suite.page.evaluate(async (workspaceId) => {
      try {
        await window.passport.call("window.move", { workspaceId });
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    }, workspaceId);
    expect(move).toContain("입력 전송");
    await suite.page.evaluate(
      (id) =>
        window.passport.call("session.input", {
          id,
          data: "printf 'OTHER_PANE_RESPONDS\\n'\r",
        }),
      local.id,
    );
    await expect(
      suite.page.locator(`[data-pane-id="${local.id}"] .xterm-rows`),
    ).toContainText("OTHER_PANE_RESPONDS");
    stream.resume();
    const framed = pasteStart + text + pasteEnd;
    await expect
      .poll(() => data.reduce((sum, chunk) => sum + chunk.length, 0), {
        timeout: 10000,
      })
      .toBe(Buffer.byteLength(framed) * 2);
    expect(digest(Buffer.concat(data))).toBe(digest(framed + framed));
    data.length = 0;
    stream.pause();
    await send();
    await send();
    await suite.page
      .getByRole("button", { name: "paste SSH", exact: true })
      .click();
    const progress = suite.page.locator(
      `[data-pane-id="${paneId}"] .terminal-input-progress`,
    );
    await expect(progress).toBeVisible();
    await suite.page.evaluate(
      (id) => window.passport.call("session.input", { id, data: "\x03" }),
      paneId,
    );
    stream.resume();
    await expect
      .poll(() =>
        Buffer.concat(data)
          .toString()
          .endsWith(pasteEnd + "\x03"),
      )
      .toBe(true);
    expect(Buffer.concat(data).length).toBeLessThan(
      Buffer.byteLength(framed) * 2,
    );
    await expect(progress).toHaveCount(0);

    // Close with an unfinished write, then reuse the pane on a new SSH channel.
    stream.pause();
    await send();
    await suite.page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      paneId,
    );
    await suite.page.evaluate(
      ({ id, hostId }) =>
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
      { id: paneId, hostId: host.id },
    );
    const fresh = (
      await suite.page.evaluate(() =>
        window.passport.call("bootstrap", undefined),
      )
    ).sessionStates.find((state) => state.id === paneId)!;
    expect(fresh.generation).not.toBe(generation);
    const freshData: Buffer[] = [];
    server.shells.at(-1)!.removeAllListeners("data");
    server.shells
      .at(-1)!
      .on("data", (chunk: Buffer) => freshData.push(Buffer.from(chunk)));
    const rejected = await suite.page.evaluate(
      async (input) => {
        try {
          await window.passport.call("session.paste", input);
          return false;
        } catch {
          return true;
        }
      },
      {
        id: paneId,
        sessionInstanceId: generation,
        text: "STALE",
        bracketedPaste: true,
      },
    );
    expect(rejected).toBe(true);
    await suite.page.evaluate(
      (input) => window.passport.call("session.paste", input),
      {
        id: paneId,
        sessionInstanceId: fresh.generation!,
        text: "FRESH",
        bracketedPaste: true,
      },
    );
    await expect
      .poll(() => Buffer.concat(freshData).toString())
      .toBe(pasteStart + "FRESH" + pasteEnd);
    await suite.page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      paneId,
    );
  } finally {
    await server.close();
  }
});
