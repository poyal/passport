import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeCleanly } from "../fixtures/electron-exit";

for (const shell of [
  "passport-bash",
  "cmd",
  "windows-powershell",
  "pwsh",
] as const) {
  test(`Windows ${shell} applies a startup profile and accepts terminal input`, async () => {
    test.skip(process.platform !== "win32", "Requires Windows shells.");
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-shell-"),
    );
    const project = path.join(directory, "한글 ' & project");
    await fs.mkdir(project);
    const application = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: path.join(directory, "data"),
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
    try {
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      });
      const page = await application.firstWindow();
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
      await expect(
        page.locator(".view:not([hidden]) .pill").first(),
      ).toHaveText("1 / 1 연결");
      await expect(page.locator(".xterm-rows")).toContainText(
        shell === "passport-bash" ? /\$\s*$/ : />\s*$/,
        { timeout: 15000 },
      );
      await page.bringToFront();
      await page.locator(".xterm-helper-textarea").focus();
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      await page.waitForFunction(() => document.hasFocus());
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      for (const command of commands) {
        await page.keyboard.type(command, { delay: 20 });
        await page.keyboard.press("Enter");
      }
      await expect(page.locator(".xterm-rows")).toContainText(
        "PROFILE_한글_100%_!_&_value",
      );
      await expect(page.locator(".xterm-rows")).toContainText(
        "PASSPORT_ALIAS_OK",
      );
      await expect(page.locator(".xterm-rows")).toContainText(
        "한글 ' & project",
      );
      const state = await page.evaluate(
        async () =>
          (await window.passport.call("bootstrap", undefined)).sessionStates[0],
      );
      expect(state.environment?.profiles.map((item) => item.id)).toEqual([
        "shell-probe",
      ]);
    } finally {
      await closeCleanly(application);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
