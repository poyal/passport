import { focusTerminalPage } from "../../scripts/e2e-electron.mjs";
import { reusableApp } from "../fixtures/reusable-app";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const suite = reusableApp({ name: "windows-shells", platform: "win32" });

test.beforeEach(async () => {
  if (!process.env.PASSPORT_INPUT_DIAGNOSTICS) return;
  await suite.application.evaluate(({ ipcMain, app }) => {
    const events: any[] = [];
    const record = (kind: string, value: unknown) =>
      events.push({ kind, value, time: Date.now() });
    const handlers = (ipcMain as any)._invokeHandlers;
    const handler = handlers.get("passport:call");
    ipcMain.removeHandler("passport:call");
    ipcMain.handle("passport:call", (event, name, input) => {
      if (
        ["session.input", "session.resize", "clipboard.terminal"].includes(name)
      )
        record(name, input);
      return handler(event, name, input);
    });
    const require = process
      .getBuiltinModule("module")
      .createRequire(app.getAppPath() + "/package.json");
    const pty = require("node-pty"),
      spawn = pty.spawn;
    const restores: (() => void)[] = [];
    pty.spawn = (...args: any[]) => {
      const terminal = spawn(...args),
        write = terminal.write,
        resize = terminal.resize;
      terminal.write = (data: string) => {
        record("pty-input", data);
        return write.call(terminal, data);
      };
      terminal.resize = (cols: number, rows: number) => {
        record("pty-resize", { cols, rows });
        return resize.call(terminal, cols, rows);
      };
      const listener = terminal.onData((data: string) =>
        record("pty-output", data),
      );
      restores.push(() => {
        listener.dispose();
        terminal.write = write;
        terminal.resize = resize;
      });
      return terminal;
    };
    (globalThis as any).__inputDiagnostics = {
      events,
      restore() {
        restores.forEach((restore) => restore());
        pty.spawn = spawn;
        ipcMain.removeHandler("passport:call");
        ipcMain.handle("passport:call", handler);
      },
    };
  });
  await suite.page.evaluate(() => {
    const events: unknown[] = [];
    (window as any).__keyDiagnostics = events;
    for (const type of ["keydown", "keypress", "input", "keyup"])
      document.addEventListener(
        type,
        (event) => {
          if (
            !(event.target as Element).classList.contains(
              "xterm-helper-textarea",
            )
          )
            return;
          events.push({
            type,
            key: (event as KeyboardEvent).key,
            data: (event as InputEvent).data,
            time: Date.now(),
          });
        },
        true,
      );
  });
});
test.afterEach(async ({}, info) => {
  if (!process.env.PASSPORT_INPUT_DIAGNOSTICS) return;
  const main = await suite.application.evaluate(() => {
    const state = (globalThis as any).__inputDiagnostics;
    state.restore();
    return state.events;
  });
  const renderer = await suite.page.evaluate(() => ({
    events: (window as any).__keyDiagnostics,
    rows: document.querySelector(".xterm-rows")?.textContent,
  }));
  await info.attach("terminal-input-diagnostics", {
    contentType: "application/json",
    body: JSON.stringify({ main, renderer }, null, 2),
  });
});

for (const shell of [
  "passport-bash",
  "cmd",
  "windows-powershell",
  "pwsh",
] as const) {
  test(`Windows ${shell} applies a startup profile and accepts terminal input`, async () => {
    test.skip(process.platform !== "win32", "Requires Windows shells.");
    const { application, page, directory } = suite;
    const project = path.join(directory, `${shell} 한글 ' & project`);
    await fs.mkdir(project);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await page.waitForSelector(".home-view");
    const boot = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    test.skip(
      !boot.shells.find((item) => item.id === shell)?.available,
      `${shell} is not installed on this machine.`,
    );
    await page.evaluate(
      async ({ shell, project }) => {
        const boot = await window.passport.call("bootstrap", undefined);
        boot.document.settings.terminal.shell = shell;
        boot.document.settings.terminal.profiles.push({
          id: "shell-probe",
          name: "Shell probe",
          revision: 1,
          origin: "user",
          platforms: ["win32"],
          shells: [shell],
          entries: [
            {
              kind: "env",
              name: "SHELL_PROBE_VALUE",
              value: "PROFILE_한글_100%_!_&_value",
              overwrite: true,
            },
            { kind: "path", value: project, position: "prepend" },
            {
              kind: "alias",
              name: "probe",
              command: "echo",
              args: ["PASSPORT_ALIAS_OK"],
              overwrite: true,
            },
          ],
        });
        boot.document.settings.terminal.profileIds = ["shell-probe"];
        await window.passport.call("save", boot.document);
      },
      { shell, project },
    );
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = (await window.passport.call("bootstrap", undefined))
            .sessionStates[0];
          return {
            status: state?.environment?.status,
            results: state?.environment?.results,
            output: document.querySelector(".xterm-rows")?.textContent,
          };
        }),
      )
      .toEqual(expect.objectContaining({ status: "ready" }));
    const commands =
      shell === "passport-bash"
        ? [
            "printf '%s\\n' \"$SHELL_PROBE_VALUE\"",
            "printf '%s\\n' \"${PATH%%:*}\"",
            "probe",
          ]
        : shell === "cmd"
          ? [
              "set SHELL_PROBE_VALUE",
              'for /f "tokens=1 delims=;" %p in ("%PATH%") do @echo "%p"',
              "probe",
            ]
          : [
              "Write-Output $env:SHELL_PROBE_VALUE",
              "Write-Output ($env:PATH -split ';')[0]",
              "probe",
            ];
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "1 / 1 연결",
    );
    await expect(page.locator(".xterm-rows")).toContainText(
      shell === "passport-bash" ? /\$\s*$/ : />\s*$/,
      { timeout: 15000 },
    );
    await focusTerminalPage(page);
    await page.locator(".xterm-helper-textarea").focus();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await page.waitForFunction(() => document.hasFocus());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const prompt = shell === "passport-bash" ? /\$\s*$/ : />\s*$/;
    const waitForResultAndPrompt = async (output: string) => {
      await expect(page.locator(".xterm-rows")).toContainText(output);
      // Command output (and OSC 133;A) can precede the next readline prompt.
      // Keep zero-delay paste-prefix typing, but begin it at a ready prompt.
      await expect(page.locator(".xterm-rows")).toContainText(prompt, {
        timeout: 15000,
      });
    };
    const outputs = [
      "PROFILE_한글_100%_!_&_value",
      "한글 ' & project",
      "PASSPORT_ALIAS_OK",
    ];
    for (const [index, command] of commands.entries()) {
      await page.keyboard.type(command, { delay: 20 });
      await page.keyboard.press("Enter");
      await waitForResultAndPrompt(outputs[index]);
    }
    await expect(page.locator(".xterm-rows")).toContainText(
      "PROFILE_한글_100%_!_&_value",
    );
    await expect(page.locator(".xterm-rows")).toContainText(
      "PASSPORT_ALIAS_OK",
    );
    await expect(page.locator(".xterm-rows")).toContainText("한글 ' & project");
    const state = await page.evaluate(
      async () =>
        (await window.passport.call("bootstrap", undefined)).sessionStates[0],
    );
    expect(state.environment?.profiles.map((item) => item.id)).toEqual([
      "shell-probe",
    ]);
    // Exercise the actual Windows shell with paths from the clipboard IPC.
    // The OS clipboard is not changed by this hidden test.
    const pastedFiles = [
      path.join(project, "붙여 넣기.txt"),
      path.join(project, "quote ' & file.txt"),
    ];
    for (const [index, file] of pastedFiles.entries())
      await fs.writeFile(file, `WINDOWS_PASTE_CONTENT_${index}\n`);
    for (const [index, file] of pastedFiles.entries()) {
      await application.evaluate(({ clipboard }, url) => {
        clipboard.read = async () =>
          [
            {
              types: ["text/uri-list"],
              getType: async () => new Blob([url]),
            },
          ] as unknown as Electron.ClipboardItem[];
      }, pathToFileURL(file).href);
      await page.keyboard.type(
        shell === "passport-bash"
          ? "cat "
          : shell === "cmd"
            ? "type "
            : "Get-Content -LiteralPath ",
      );
      await page.keyboard.press("Control+Shift+v");
      await expect(page.locator(".xterm-rows")).toContainText(
        path
          .basename(file)
          .replaceAll(
            "'",
            shell === "passport-bash" ? "'\\''" : shell === "cmd" ? "'" : "''",
          ),
      );
      await page.keyboard.press("Enter");
      await waitForResultAndPrompt(`WINDOWS_PASTE_CONTENT_${index}`);
    }
  });
}
