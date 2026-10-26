import { test, expect, type JSHandle } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reusableApp } from "../fixtures/reusable-app";
import { hostSchema } from "../../src/shared/model";
import { quotePastePaths } from "../../src/shared/paste";
import { LOCAL_HOST_ID } from "../../src/shared/advanced";

const suite = reusableApp({ name: "terminal-input" });
const os = process.platform === "darwin" ? "darwin" : "win32";
type Input = { id: string; data: string; sessionInstanceId?: string };
const boot = () =>
  suite.page.evaluate(() => window.passport.call("bootstrap", undefined));
const inputs = () =>
  suite.application.evaluate(
    () => (globalThis as any).__terminalInputTest.inputs as Input[],
  );
const clearInputs = () =>
  suite.application.evaluate(() => {
    (globalThis as any).__terminalInputTest.inputs = [];
  });
const body = (id: string) =>
  suite.page.locator(`[data-pane-id="${id}"] .terminal-body`);
const textarea = (id: string) =>
  suite.page.locator(`[data-pane-id="${id}"] .xterm-helper-textarea`);
const clean = (text: string) => text.replace(/\x1b\[(?:200|201)~/g, "");

test.beforeEach(async () => {
  expect(
    await suite.application.evaluate(
      () => (globalThis as any).__terminalInputTest === undefined,
    ),
  ).toBe(true);
  await suite.page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(
    suite.page.locator(".view:not([hidden]) .pill").first(),
  ).toHaveText("1 / 1 연결");
  await suite.application.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get("passport:call");
    const state: any = ((globalThis as any).__terminalInputTest = {
      inputs: [],
      held: false,
      hold: false,
      release: undefined,
      original,
      clipboardText: undefined,
    });
    ipcMain.removeHandler("passport:call");
    ipcMain.handle("passport:call", async (event, name, input) => {
      if (name === "clipboard.terminal" && state.clipboardText !== undefined)
        return { ok: true, value: { kind: "text", text: state.clipboardText } };
      if (name === "session.input" || name === "session.paste") {
        if (name === "session.paste") {
          const text = input.text
            .replace(/[\r\n]+$/, "")
            .replace(/\r?\n/g, "\r");
          input = {
            ...input,
            data: input.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text,
          };
        }
        if (["\x1b[?1;2c", "\x1b[I", "\x1b[O"].includes(input.data))
          return original(event, name, input);
        state.inputs.push(input);
        return { ok: true, value: undefined };
      }
      const result = await original(event, name, input);
      if (name === "terminal.drop" && state.hold) {
        state.held = true;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        state.held = false;
      }
      return result;
    });
  });
});
test.afterEach(async () => {
  const restored = await suite.application.evaluate(({ ipcMain }) => {
    const state = (globalThis as any).__terminalInputTest;
    state?.release?.();
    if (state) {
      ipcMain.removeHandler("passport:call");
      ipcMain.handle("passport:call", state.original);
    }
    delete (globalThis as any).__terminalInputTest;
    return (
      !state ||
      (ipcMain as any)._invokeHandlers.get("passport:call") === state.original
    );
  });
  expect(restored).toBe(true);
});

async function files(
  names = [
    "한 글.png",
    "a'b {{literal}}.jpg",
    "레거시-레인-통합-검토.md",
    "설명.pdf",
    "자료.zip",
    "확장자없음",
    "빈 파일.txt",
  ],
) {
  const paths = names.map((name) => path.join(suite.directory, name));
  for (const file of paths)
    await fs.writeFile(
      file,
      file.endsWith("빈 파일.txt")
        ? ""
        : /\.(png|jpg)$/i.test(file)
          ? Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            )
          : "File drop fixture contents",
    );
  await suite.page.evaluate(() => {
    document.getElementById("drop-fixture")?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "drop-fixture";
    input.hidden = true;
    document.body.append(input);
  });
  await suite.page.locator("#drop-fixture").setInputFiles(paths);
  const transfer = await suite.page.evaluateHandle(() => {
    const data = new DataTransfer();
    for (const file of (
      document.getElementById("drop-fixture") as HTMLInputElement
    ).files!)
      data.items.add(file);
    return data;
  });
  return { paths, transfer };
}
async function drop(id: string, transfer: JSHandle<DataTransfer>) {
  await body(id).dispatchEvent("dragover", { dataTransfer: transfer });
  await body(id).dispatchEvent("drop", { dataTransfer: transfer });
}
async function saveNewline(keys: string[]) {
  await suite.page.evaluate(
    async ({ keys, os }) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.settings.shortcuts[os as "darwin" | "win32"].newline = keys;
      await window.passport.call("save", document);
    },
    { keys, os },
  );
}

test("file hover identifies one pane and rejects SSH without changing focus or layout", async ({}, info) => {
  const original = await boot();
  const first = original.document.workspaces[0].root;
  if (first.kind !== "pane") throw new Error("Expected initial local pane");
  const second = { ...first, id: randomUUID() };
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "SSH only",
    address: "127.0.0.1",
    username: "fixture",
  });
  const remote = { kind: "pane" as const, id: randomUUID(), hostId: host.id };
  const root = {
    kind: "split" as const,
    id: randomUUID(),
    direction: "horizontal" as const,
    ratio: 0.5,
    children: [
      first,
      {
        kind: "split" as const,
        id: randomUUID(),
        direction: "horizontal" as const,
        ratio: 0.5,
        children: [second, remote],
      },
    ],
  };
  await suite.page.evaluate(
    async ({ root, host }) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.hosts.push(host);
      document.workspaces[0].root = root as any;
      await window.passport.call("save", document);
    },
    { root, host },
  );
  await expect(suite.page.locator(".terminal-pane")).toHaveCount(3);
  await suite.page.evaluate(
    (input) => window.passport.call("session.connect", input),
    { id: second.id, hostId: LOCAL_HOST_ID },
  );
  await expect
    .poll(
      async () =>
        (await boot()).sessionStates.find((s) => s.id === second.id)?.status,
    )
    .toBe("connected");
  const { transfer } = await files();
  await textarea(first.id).focus();
  for (const theme of ["light", "dark"] as const) {
    await suite.page.evaluate(async (theme) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.settings.colorMode = theme;
      await window.passport.call("save", document);
    }, theme);
    await body(first.id).dispatchEvent("dragover", { dataTransfer: transfer });
    await body(second.id).dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(suite.page.locator(".file-drop-target")).toHaveCount(1);
    await expect(body(second.id).getByRole("status")).toContainText(
      "이 터미널에 파일·폴더 경로 추가",
    );
    await expect(textarea(first.id)).toBeFocused();
    const bounds = await body(second.id).boundingBox();
    await body(second.id)
      .locator(".terminal-mount")
      .dispatchEvent("dragleave", {
        dataTransfer: transfer,
        relatedTarget: null,
        clientX: bounds!.x + bounds!.width / 2,
        clientY: bounds!.y + bounds!.height / 2,
      });
    await expect(body(second.id).getByRole("status")).toBeVisible();
    expect(
      await body(second.id)
        .locator(".file-drop-overlay")
        .evaluate((e) => getComputedStyle(e).pointerEvents),
    ).toBe("none");
    await suite.page.screenshot({
      path: info.outputPath(`file-hover-${theme}.png`),
    });
    await body(remote.id).dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(body(remote.id).getByRole("status")).toContainText(
      "SSH 터미널에서는 파일·폴더 드래그앤드롭을 지원하지 않습니다.",
    );
    await drop(remote.id, transfer);
    await expect(suite.page.locator(".file-drop-overlay")).toHaveCount(0);
    expect(await inputs()).toEqual([]);
  }
  await body(second.id).dispatchEvent("dragover", { dataTransfer: transfer });
  await suite.page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(suite.page.locator(".file-drop-overlay")).toHaveCount(0);
  await body(second.id).dispatchEvent("dragover", { dataTransfer: transfer });
  await suite.page.keyboard.press("Escape");
  await expect(suite.page.locator(".file-drop-overlay")).toHaveCount(0);
  await clearInputs();
  await suite.page
    .locator(".pane-header")
    .first()
    .dispatchEvent("drop", { dataTransfer: transfer });
  expect(await inputs()).toEqual([]);
  expect((await boot()).document.workspaces[0].root).toEqual(root);
  // Drop routes to the hovered pane even when another pane was active.
  await drop(second.id, transfer);
  await expect
    .poll(async () => (await inputs()).map((i) => i.id))
    .toEqual([second.id]);
  await expect(textarea(second.id)).toBeFocused();
  await transfer.dispose();
});

test("file drops and clipboard paste retain gesture order", async () => {
  const state = (await boot()).sessionStates[0];
  const first = await files(["first.md"]);
  const last = await files(["last.zip"]);
  await suite.application.evaluate(() => {
    const state = (globalThis as any).__terminalInputTest;
    state.hold = true;
    state.clipboardText = "clipboard middle";
  });
  await drop(state.id, first.transfer);
  await expect
    .poll(() =>
      suite.application.evaluate(
        () => (globalThis as any).__terminalInputTest.held,
      ),
    )
    .toBe(true);
  await suite.application.evaluate(() => {
    (globalThis as any).__terminalInputTest.hold = false;
  });
  await suite.page.keyboard.press(os === "darwin" ? "Meta+v" : "Control+v");
  await drop(state.id, last.transfer);
  expect(await inputs()).toEqual([]);
  await suite.application.evaluate(() => {
    (globalThis as any).__terminalInputTest.release();
  });
  await expect
    .poll(async () => (await inputs()).map((i) => clean(i.data)))
    .toEqual([
      ` ${quotePastePaths(first.paths, state.environment!.shell)} `,
      "clipboard middle",
      ` ${quotePastePaths(last.paths, state.environment!.shell)} `,
    ]);
  await first.transfer.dispose();
  await last.transfer.dispose();
});

test("disk-backed file drops preserve text and paths and reject synthetic files", async () => {
  const state = (await boot()).sessionStates[0];
  const { transfer, paths } = await files();
  await textarea(state.id).focus();
  await suite.page.keyboard.type("draft ");
  const draft = (await inputs()).map((i) => i.data).join("");
  await drop(state.id, transfer);
  await expect
    .poll(
      async () => (await inputs()).filter((i) => i.sessionInstanceId).length,
    )
    .toBe(1);
  const sent = await inputs();
  expect(
    sent
      .slice(0, -1)
      .map((i) => i.data)
      .join(""),
  ).toBe(draft);
  expect(clean(sent.at(-1)!.data)).toBe(
    ` ${quotePastePaths(paths, state.environment!.shell)} `,
  );
  expect(sent.at(-1)!.sessionInstanceId).toBe(
    state.environment!.sessionInstanceId,
  );
  expect(sent.map((i) => i.data).join("")).not.toMatch(/[\r\n]/);
  await clearInputs();
  const folder = path.join(suite.directory, "프로젝트 폴더");
  await fs.mkdir(folder);
  const preparedFolder = await suite.page.evaluate(
    (input) => window.passport.call("terminal.drop", input),
    {
      id: state.id,
      paths: [folder],
      sessionInstanceId: state.environment!.sessionInstanceId,
    },
  );
  expect(preparedFolder.text).toBe(
    ` ${quotePastePaths([folder], state.environment!.shell)} `,
  );
  const invalid = await files(["good.md"]);
  await invalid.transfer.evaluate((transfer) => {
    transfer.items.add(
      new File(["no disk path"], "synthetic.md", { type: "text/markdown" }),
    );
  });
  await drop(state.id, invalid.transfer);
  await expect(suite.page.getByRole("alert")).toContainText(
    "실제 파일 경로가 없는",
  );
  expect(await inputs()).toEqual([]);
  const message = await suite.page.evaluate(async (state) => {
    try {
      await window.passport.prepareTerminalDrop({
        id: state.id,
        sessionInstanceId: state.environment!.sessionInstanceId,
        files: [new File(["image"], "fake.png", { type: "image/png" })],
      });
      return "unexpected success";
    } catch (error) {
      return (error as Error).message;
    }
  }, state);
  expect(message).toContain("실제 파일 경로가 없는");
  await transfer.dispose();
  await invalid.transfer.dispose();
});

test("pending drops are discarded on reconnect and stale generations are rejected by main", async () => {
  const state = (await boot()).sessionStates[0];
  const { transfer } = await files();
  await suite.application.evaluate(() => {
    (globalThis as any).__terminalInputTest.hold = true;
  });
  await drop(state.id, transfer);
  await expect
    .poll(() =>
      suite.application.evaluate(
        () => (globalThis as any).__terminalInputTest.held,
      ),
    )
    .toBe(true);
  await suite.page.evaluate(
    async ({ id, hostId }) => {
      await window.passport.call("session.close", { id });
      await window.passport.call("session.connect", { id, hostId });
    },
    { id: state.id, hostId: LOCAL_HOST_ID },
  );
  await expect
    .poll(async () => (await boot()).sessionStates[0]?.status)
    .toBe("connected");
  await suite.application.evaluate(() => {
    const state = (globalThis as any).__terminalInputTest;
    state.hold = false;
    state.release();
  });
  // A later successful drop is the queue barrier; the old generation must never be delivered.
  await drop(state.id, transfer);
  await expect.poll(async () => (await inputs()).length).toBe(1);
  expect((await inputs())[0].sessionInstanceId).not.toBe(
    state.environment!.sessionInstanceId,
  );
  await suite.application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("passport:call");
    ipcMain.handle(
      "passport:call",
      (globalThis as any).__terminalInputTest.original,
    );
  });
  const rejected = await suite.page.evaluate(async (state) => {
    try {
      await window.passport.call("session.input", {
        id: state.id,
        data: "old",
        sessionInstanceId: state.environment!.sessionInstanceId,
      });
      return false;
    } catch {
      return true;
    }
  }, state);
  expect(rejected).toBe(true);
  await transfer.dispose();
});

test("newline sends Shift Enter once and preserves Enter, IME and disabled bindings", async () => {
  const { id } = (await boot()).sessionStates[0];
  await textarea(id).focus();
  await suite.page.keyboard.press("Shift+Enter");
  await suite.page.keyboard.press("Enter");
  await suite.page.keyboard.press("Shift+NumpadEnter");
  await expect
    .poll(async () => (await inputs()).map((i) => i.data))
    .toEqual(["\x1b[13;2u", "\r", "\x1b[13;2u"]);
  await clearInputs();
  await textarea(id).dispatchEvent("compositionstart");
  await textarea(id).dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    isComposing: true,
    keyCode: 229,
  });
  await textarea(id).dispatchEvent("compositionend", { data: "" });
  await textarea(id).dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    repeat: true,
  });
  expect(await inputs()).toEqual([]);
  await saveNewline(["Ctrl+Enter"]);
  await textarea(id).focus();
  await suite.page.keyboard.press("Shift+Enter");
  await suite.page.keyboard.press("Control+Enter");
  await expect
    .poll(async () => (await inputs()).map((i) => i.data))
    .toEqual(["\x1b[13;2u"]);
  await clearInputs();
  await saveNewline([]);
  await textarea(id).focus();
  await suite.page.keyboard.press("Shift+Enter");
  await suite.page.keyboard.press("a");
  await expect
    .poll(async () => (await inputs()).map((i) => i.data))
    .toEqual(["a"]);
});

test("newline editor records modified Enter and supports disable and reset", async () => {
  await suite.page.getByRole("button", { name: "설정", exact: true }).click();
  await suite.page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "단축키", exact: true })
    .click();
  await suite.page
    .getByRole("button", { name: "줄바꿈 키 변경", exact: true })
    .click();
  await suite.page
    .getByLabel("키 조합", { exact: true })
    .press("Control+Enter");
  await suite.page.getByRole("button", { name: "적용", exact: true }).click();
  await suite.page
    .getByRole("button", { name: "단축키 저장", exact: true })
    .click();
  await expect
    .poll(async () => (await boot()).document.settings.shortcuts[os].newline)
    .toEqual(["Ctrl+Enter"]);
  await suite.page
    .getByRole("button", { name: "줄바꿈 단축키 해제", exact: true })
    .click();
  await suite.page
    .getByRole("button", { name: "단축키 저장", exact: true })
    .click();
  await expect
    .poll(async () => (await boot()).document.settings.shortcuts[os].newline)
    .toEqual([]);
  await suite.page
    .getByRole("button", { name: "줄바꿈 초기화", exact: true })
    .click();
  await suite.page
    .getByRole("button", { name: "단축키 저장", exact: true })
    .click();
  await expect
    .poll(async () => (await boot()).document.settings.shortcuts[os].newline)
    .toEqual(["Shift+Enter"]);
  expect(await inputs()).toEqual([]);
});
