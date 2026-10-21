import { electron } from "../../scripts/e2e-electron.mjs";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";
import { closeCleanly } from "../fixtures/electron-exit";
import { reusableApp } from "../fixtures/reusable-app";
import { waitForLocalPrompt } from "../fixtures/terminal-ready";

test.describe("local workspace UI", () => {
  const suite = reusableApp({ name: "local-workspace" });
  test("an unavailable default shell leaves a retryable local tab", async () => {
    const { application, page } = suite;
    await expect(
      page.getByRole("button", { name: "새 로컬 터미널", exact: true }),
    ).toBeVisible();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await page.evaluate(async () => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.settings.terminal.shell =
        boot.platform === "win32" ? "zsh" : "cmd";
      await window.passport.call("save", boot.document);
    });
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined))
              .sessionStates[0]?.status,
        ),
      )
      .toBe("error");
    const state = (
      await page.evaluate(() => window.passport.call("bootstrap", undefined))
    ).sessionStates[0];
    await expect(page.locator(".connection-banner")).toContainText(
      state.message!,
    );
    await expect(
      page
        .locator(".connection-banner")
        .getByRole("button", { name: "연결", exact: true }),
    ).toBeEnabled();
    await page.evaluate(async () => {
      const boot = await window.passport.call("bootstrap", undefined);
      const pane = boot.document.workspaces[0].root;
      const shell = boot.platform === "win32" ? "passport-bash" : "default";
      if (pane.kind === "pane") pane.local!.shell = shell;
      boot.document.settings.terminal.shell = shell;
      await window.passport.call("save", boot.document);
    });
    await page
      .locator(".connection-banner")
      .getByRole("button", { name: "연결", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined))
              .sessionStates[0]?.status,
        ),
      )
      .toBe("connected");
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined))
              .sessionStates[0]?.environment?.status,
        ),
      )
      .toBe("ready");
    // The Mac login shell may be zsh with a '%' prompt. Verify the recovered
    // PTY executes input instead of depending on a user's prompt appearance.
    await page.evaluate(async () => {
      const boot = await window.passport.call("bootstrap", undefined);
      await window.passport.call("session.input", {
        id: boot.sessionStates[0].id,
        data: "printf 'RETRY_%s\\n' READY\r",
      });
    });
    await expect(page.locator(".xterm-rows")).toContainText("RETRY_READY");
  });

  test("creates mixed local/SSH workspaces, previews profiles, routes alerts and restores without executing", async ({}, info) => {
    const { application, page } = suite;
    const directory = path.join(suite.directory, "mixed");
    await fs.mkdir(directory);
    const project = path.join(directory, "한글 project");
    await fs.mkdir(project);
    const server = await sshFixture(directory);
    try {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      });
      await expect(
        page.getByRole("heading", {
          name: "한 작업 공간에서 로컬 AI와 SSH를 함께",
        }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath("home.png") });
      const host = hostSchema.parse({
        id: crypto.randomUUID(),
        name: "옆 서버",
        address: "127.0.0.1",
        port: server.port,
        username: "tester",
      });
      await page.evaluate(
        async ({ host }) => {
          const b = await window.passport.call("bootstrap", undefined);
          b.document.hosts.push(host);
          b.document.settings.notifications.desktop = "off";
          await window.passport.call("save", b.document);
        },
        { host },
      );
      await page.getByRole("button", { name: "설정", exact: true }).click();
      await page
        .locator(".settings-sidebar")
        .getByRole("button", { name: "로컬 터미널", exact: true })
        .click();
      await page
        .getByLabel("기본 셸", { exact: true })
        .selectOption(process.platform === "win32" ? "passport-bash" : "bash");
      await page
        .getByLabel("시작 프로파일", { exact: true })
        .selectOption("custom");
      await page.getByRole("checkbox", { name: /Unix 단축명령/ }).check();
      await page.screenshot({ path: info.outputPath("local-settings.png") });
      await page
        .getByRole("button", { name: "새 로컬 터미널", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect
        .poll(async () =>
          page.evaluate(
            async () =>
              (await window.passport.call("bootstrap", undefined))
                .sessionStates[0]?.environment?.status,
          ),
        )
        .toBe("ready");
      const local = await page
        .locator(".terminal-pane")
        .getAttribute("data-pane-id");
      expect(local).toBeTruthy();
      await page
        .getByRole("button", { name: "실행 환경", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toContainText(
        await page.evaluate(
          async () => (await window.passport.call("bootstrap", undefined)).home,
        ),
      );
      await expect(page.getByRole("dialog")).toContainText("Unix 단축명령");
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      await page
        .getByRole("button", { name: "터미널 분할", exact: true })
        .click();
      await page.getByRole("button", { name: "SSH", exact: true }).click();
      await page.getByRole("button", { name: /옆 서버/ }).click();
      await page
        .getByLabel("비밀번호", { exact: true })
        .fill("test-only-password");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "연결", exact: true })
        .click();
      await expect(
        page.locator(".view:not([hidden]) .terminal-pane"),
      ).toHaveCount(2);
      await expect.poll(() => server.shells.length).toBe(1);
      await page.screenshot({ path: info.outputPath("mixed-workspace.png") });
      const before = await page.evaluate(
        async () =>
          (
            await window.passport.call("bootstrap", undefined)
          ).sessionStates.find((s) => s.environment)?.environment
            ?.sessionInstanceId,
      );
      await expect(
        page.locator(`.terminal-pane[data-pane-id="${local}"] .xterm-rows`),
      ).toContainText(/\$\s*$/);
      // A terminal OSC can request attention, but cannot claim authenticated approval.
      const localInput = page.locator(
        `.terminal-pane[data-pane-id="${local}"] .xterm-helper-textarea`,
      );
      await localInput.focus();
      await expect(localInput).toBeFocused();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.keyboard.type(
        "printf '\\033]9;attention\\007\\nOSC_%s\\n' COMMAND_DONE",
        { delay: 20 },
      );
      await page.keyboard.press("Enter");
      await expect(
        page.locator(`.terminal-pane[data-pane-id="${local}"] .xterm-rows`),
      ).toContainText("OSC_COMMAND_DONE");
      await expect
        .poll(async () =>
          page.evaluate(
            async () =>
              (await window.passport.call("activity.list", undefined)).length,
          ),
        )
        .toBe(1);
      await page.getByRole("button", { name: "알림함", exact: true }).click();
      await expect(page.locator(".activity-row")).toContainText(
        "터미널 · 확인 필요",
      );
      await page.screenshot({ path: info.outputPath("activity.png") });
      await page
        .getByRole("button", { name: "터미널 보기", exact: true })
        .click();
      await expect(
        page.locator(`.terminal-pane[data-pane-id="${local}"]`),
      ).toHaveClass(/focused/);
      expect(
        await page.evaluate(
          async () =>
            (
              await window.passport.call("bootstrap", undefined)
            ).sessionStates.find((s) => s.environment)?.environment
              ?.sessionInstanceId,
        ),
      ).toBe(before);
      const logs = await page.evaluate(async () =>
        window.passport.call("logs.list", undefined),
      );
      expect(logs.some((log) => log.sessionId === local)).toBe(false);
      // An alert click waits for an existing dialog instead of stealing its input.
      await page
        .getByRole("button", { name: "실행 환경", exact: true })
        .click();
      await page.evaluate(async () => {
        const [item] = await window.passport.call("activity.list", undefined);
        await window.passport.call("activity.open", { id: item.id });
      });
      await expect(
        page.getByRole("dialog", { name: "실행 환경" }),
      ).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "닫기", exact: true })
        .click();
      await page.getByRole("button", { name: "템플릿", exact: true }).click();
      await page.getByRole("button", { name: "탭 저장", exact: true }).click();
      await page.getByRole("dialog").getByRole("textbox").fill("혼합 작업");
      await page.getByRole("button", { name: "저장", exact: true }).click();
      await page
        .getByRole("button", { name: "혼합 작업 배치만 열기", exact: true })
        .click();
      expect(
        await page.evaluate(
          async () =>
            (
              await window.passport.call("bootstrap", undefined)
            ).sessionStates.filter((s) => s.status === "connected").length,
        ),
      ).toBe(2);
      const moved = application.waitForEvent("window");
      await page.evaluate(async () => {
        const b = await window.passport.call("bootstrap", undefined);
        await window.passport.call("window.move", {
          workspaceId: b.document.workspaces[0].id,
        });
      });
      const target = await moved;
      await page.evaluate(async () => {
        const [item] = await window.passport.call("activity.list", undefined);
        await window.passport.call("activity.open", { id: item.id });
      });
      await expect(
        target.locator(`.terminal-pane[data-pane-id="${local}"]`),
      ).toHaveClass(/focused/);
      expect(
        await target.evaluate(
          async () =>
            (await window.passport.call("activity.list", undefined)).length,
        ),
      ).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("edits several startup profiles and notification preferences without touching live shells", async ({}, info) => {
    const { application, page } = suite;
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page
      .locator(".settings-sidebar")
      .getByRole("button", { name: "로컬 터미널", exact: true })
      .click();
    await page.getByRole("button", { name: "추가", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByLabel("이름", { exact: true }).fill("개발 환경");
    await modal.getByRole("button", { name: "env", exact: true }).click();
    await modal.getByLabel("이름", { exact: true }).nth(1).fill("PROJECT_MODE");
    await modal.getByLabel("값", { exact: true }).fill("development");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    await page
      .getByLabel("시작 프로파일", { exact: true })
      .selectOption("custom");
    await page.getByRole("checkbox", { name: /개발 환경/ }).check();
    await page.getByRole("checkbox", { name: /AI 작업 알림/ }).check();
    await expect(page.getByRole("status")).toContainText(
      "프로파일만 선택된 상태",
    );
    await page
      .getByRole("switch", { name: "Claude Code 알림 연동", exact: true })
      .click();
    await page.screenshot({ path: info.outputPath("profiles.png") });
    await page
      .locator(".settings-sidebar")
      .getByRole("button", { name: "AI 작업 알림", exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: "Claude Code 알림", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    const state = await page.evaluate(async () =>
      window.passport.call("bootstrap", undefined),
    );
    expect(state.document.settings.terminal.profileIds).toHaveLength(
      process.platform === "win32" ? 3 : 2,
    );
    expect(state.document.settings.notifications.claude).toBe(true);
    expect(state.sessionStates).toEqual([]);
    await application.evaluate(({ shell }) => {
      (globalThis as any).notificationSettingsUrls = [];
      shell.openExternal = async (url) => {
        (globalThis as any).notificationSettingsUrls.push(url);
      };
    });
    await page
      .getByRole("button", { name: "운영체제 알림 설정 열기", exact: true })
      .click();
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as any).notificationSettingsUrls,
        ),
      )
      .toEqual([
        process.platform === "darwin"
          ? "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
          : "ms-settings:notifications",
      ]);
    await page.screenshot({ path: info.outputPath("notifications.png") });
  });
});

test("manually launched CLI wrappers deliver completion and input alerts and respect foreground policy @desktop", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-notify-e2e-"),
  );
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  const shellDirectory = path.join(directory, "shell");
  if (process.platform === "darwin") {
    await fs.mkdir(shellDirectory);
    await fs.writeFile(
      path.join(shellDirectory, ".zshrc"),
      "HISTFILE=/dev/null\nPROMPT='PASSPORT_FIXTURE_READY > '\n",
    );
  }
  const fixture = path.join(directory, "cli.cjs");
  const claudeReady = path.join(directory, "claude-ready");
  const releaseClaude = path.join(directory, "release-claude");
  await fs.writeFile(
    fixture,
    `
const fs = require('node:fs'), {spawnSync} = require('node:child_process');
const agent = process.argv[2], args = process.argv.slice(3);
if(args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
const send = (command, argv, input, shell = false) => {
  const result = spawnSync(command, argv, {input: JSON.stringify(input), encoding:'utf8', shell});
  if(result.error || result.status) throw new Error('hook failed');
};
if(agent === 'claude') {
  fs.writeFileSync(${JSON.stringify(claudeReady)}, 'ready');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(${JSON.stringify(releaseClaude)})) {
    if (Date.now() > deadline) throw new Error('foreground fixture was not released');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1], 'utf8'));
  for(const [name,payload] of [['Notification',{notification_type:'permission_prompt',tool_use_id:'permission'}],['Stop',{}]]) {
    const hook = settings.hooks[name][0].hooks[0];
    send(hook.command, [], {hook_event_name:name,session_id:'fixture',...payload}, true);
  }
} else {
  const config = args.find(a => a.startsWith('notify='));
  if(!config) throw new Error('notify was not injected');
  const [command,...notifyArgs] = JSON.parse(config.slice(7));
  send(command, [...notifyArgs,JSON.stringify({type:'agent-turn-complete','thread-id':'fixture','turn-id':'turn'})]);
  process.stdout.write('\\x1b]9;approval requested\\x07');
}
console.log('CLI_FIXTURE_FINISHED');
`,
  );
  const quote = (value: string) => "'" + value.split("'").join("'\"'\"'") + "'";
  for (const agent of ["claude", "codex"])
    await fs.writeFile(
      path.join(bin, agent + (process.platform === "win32" ? ".cmd" : "")),
      process.platform === "win32"
        ? `@"${process.execPath}" "${fixture}" ${agent} %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${agent} "$@"\n`,
      { mode: 0o755 },
    );
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: path.join(directory, "data"),
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
      PASSPORT_E2E_NOTIFICATIONS: "1",
      ...(process.platform === "darwin" ? { ZDOTDIR: shellDirectory } : {}),
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    await application.evaluate(({ dialog, app, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      (globalThis as any).notificationTitles = [];
      (globalThis as any).notificationFocus = [];
      const recordFocus = (event: string) => {
        (globalThis as any).notificationFocus.push({
          event,
          focused: BrowserWindow.getFocusedWindow()?.id ?? null,
          at: Date.now(),
        });
      };
      app.on("browser-window-focus", () => recordFocus("focus"));
      app.on("browser-window-blur", () => recordFocus("blur"));
      // Native isSupported()/construction register Windows shortcuts even when
      // show is mocked. Replace the isolated fixture adapter before either call.
      const adapter = (globalThis as any).__passportE2ENotifications;
      if (!adapter) throw new Error("Missing isolated notification fixture");
      const { EventEmitter } = process.getBuiltinModule("node:events");
      adapter.isSupported = () => true;
      adapter.create = ({ title }: { title: string }) =>
        Object.assign(new EventEmitter(), {
          title,
          show() {
            recordFocus("notification");
            (globalThis as any).notificationTitles.push(title);
          },
          close() {},
        });
    });
    await page.evaluate(
      async ({ bin, directory }) => {
        const b = await window.passport.call("bootstrap", undefined);
        b.document.settings.notifications = {
          claude: true,
          codex: true,
          desktop: "background",
          preview: false,
          includeResponse: false,
          sound: false,
        };
        b.document.settings.terminal.shell =
          b.platform === "win32" ? "passport-bash" : "zsh";
        b.document.settings.terminal.profiles.push({
          id: "fixture-path",
          name: "Fixture CLI",
          revision: 1,
          origin: "user",
          platforms: ["darwin", "win32"],
          shells: ["zsh", "passport-bash"],
          entries: [{ kind: "path", value: bin, position: "prepend" }],
        });
        b.document.settings.terminal.profileIds = [
          "fixture-path",
          "ai-notifications",
        ];
        await window.passport.call("save", b.document);
      },
      { bin, directory },
    );
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined))
              .sessionStates[0]?.environment?.status,
        ),
      )
      .toBe("ready");
    const pane = (
      await page.evaluate(() => window.passport.call("bootstrap", undefined))
    ).sessionStates[0].id;
    if (process.platform === "darwin")
      await expect(page.locator(".xterm-rows")).toContainText(
        "PASSPORT_FIXTURE_READY > ",
      );
    else await waitForLocalPrompt(page);
    // This case checks native foreground notification policy, not keyboard
    // composition. Deliver its setup command atomically so the desktop IME
    // or a held physical modifier cannot alter the shell's return marker.
    await page.evaluate(
      (id) =>
        window.passport.call("session.input", {
          id,
          data: "claude; printf '\\nPASSPORT_%s\\n' CLAUDE_RETURNED\r",
        }),
      pane,
    );
    // Start the real CLI wrapper first, then release the mock's notifications
    // only after native and renderer focus are confirmed. CLI startup and prior
    // desktop activation can otherwise change focus between setup and delivery.
    await expect
      .poll(() => fs.readFile(claudeReady, "utf8").catch(() => ""))
      .toBe("ready");
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          return BrowserWindow.getFocusedWindow() === win && win.isVisible();
        }),
      )
      .toBe(true);
    await page.locator(".xterm-helper-textarea").focus();
    await expect
      .poll(() => page.evaluate(() => document.hasFocus()))
      .toBe(true);
    await fs.writeFile(releaseClaude, "go");
    // A Stop hook can arrive before the CLI exits. Require the real shell's
    // return marker before checking alerts and starting the background command.
    await expect(page.locator(".xterm-rows")).toContainText(
      "PASSPORT_CLAUDE_RETURNED",
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.passport.call("activity.list", undefined)),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "claude", kind: "permission" }),
          expect.objectContaining({ source: "claude", kind: "completed" }),
        ]),
      );
    expect(
      await application.evaluate(() => (globalThis as any).notificationTitles),
      JSON.stringify(
        await application.evaluate(() => (globalThis as any).notificationFocus),
      ),
    ).toEqual([]);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide(),
    );
    await page.evaluate(
      (id) => window.passport.call("session.input", { id, data: "codex\r" }),
      pane,
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.passport.call("activity.list", undefined)),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "codex", kind: "completed" }),
          expect.objectContaining({ source: "terminal", kind: "attention" }),
        ]),
      );
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as any).notificationTitles.length,
        ),
      )
      .toBe(2);
  } finally {
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
