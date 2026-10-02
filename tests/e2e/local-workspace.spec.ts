import { electron } from "../../scripts/e2e-electron.mjs";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";
import { closeCleanly } from "../fixtures/electron-exit";

test("an unavailable default shell leaves a retryable local tab", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-shell-error-"),
  );
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: directory,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  try {
    const page = await application.firstWindow();
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
  } finally {
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("creates mixed local/SSH workspaces, previews profiles, routes alerts and restores without executing", async ({}, info) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-local-e2e-"),
  );
  const project = path.join(directory, "한글 project");
  await fs.mkdir(project);
  const server = await sshFixture(directory);
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
    const page = await application.firstWindow();
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
    await page.getByRole("button", { name: "실행 환경", exact: true }).click();
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
        (await window.passport.call("bootstrap", undefined)).sessionStates.find(
          (s) => s.environment,
        )?.environment?.sessionInstanceId,
    );
    // A terminal OSC can request attention, but cannot claim authenticated approval.
    await page.evaluate(async (id) => {
      await window.passport.call("session.input", {
        id: id!,
        data: "printf '\\033]9;attention\\007'\r",
      });
    }, local);
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
    await page.getByRole("button", { name: "실행 환경", exact: true }).click();
    await page.evaluate(async () => {
      const [item] = await window.passport.call("activity.list", undefined);
      await window.passport.call("activity.open", { id: item.id });
    });
    await expect(page.getByRole("dialog", { name: "실행 환경" })).toBeVisible();
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
    await closeCleanly(application);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("edits several startup profiles and notification preferences without touching live shells", async ({}, info) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-settings-e2e-"),
  );
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: directory,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  try {
    const page = await application.firstWindow();
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
  } finally {
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("manually launched CLI wrappers deliver completion and input alerts and respect foreground policy @desktop", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-notify-e2e-"),
  );
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  const fixture = path.join(directory, "cli.cjs");
  await fs.writeFile(
    fixture,
    `
const fs = require('node:fs'), {spawnSync} = require('node:child_process');
const agent = process.argv[2], args = process.argv.slice(3);
if(args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
const send = (command, argv, input) => {
  const result = spawnSync(command, argv, {input: JSON.stringify(input), encoding:'utf8'});
  if(result.error || result.status) throw new Error('hook failed');
};
if(agent === 'claude') {
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1], 'utf8'));
  for(const [name,payload] of [['Notification',{notification_type:'permission_prompt',tool_use_id:'permission'}],['Stop',{}]]) {
    const hook = settings.hooks[name][0].hooks[0];
    send(hook.command, hook.args, {hook_event_name:name,session_id:'fixture',...payload});
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
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    await application.evaluate(({ dialog, Notification }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      (globalThis as any).notificationTitles = [];
      Notification.prototype.show = function () {
        (globalThis as any).notificationTitles.push(this.title);
      };
    });
    await page.evaluate(
      async ({ bin, directory }) => {
        const b = await window.passport.call("bootstrap", undefined);
        b.document.settings.notifications = {
          claude: true,
          codex: true,
          desktop: "background",
          preview: false,
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
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await expect
      .poll(() =>
        application.evaluate(
          ({ BrowserWindow }) => !!BrowserWindow.getFocusedWindow(),
        ),
      )
      .toBe(true);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(
      "claude; printf '\\nPASSPORT_%s\\n' CLAUDE_RETURNED",
    );
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.passport.call("activity.list", undefined)),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "claude", kind: "permission" }),
          expect.objectContaining({ source: "claude", kind: "attention" }),
        ]),
      );
    expect(
      await application.evaluate(() => (globalThis as any).notificationTitles),
    ).toEqual([]);
    // A Stop hook can arrive before the CLI exits. Wait for the shell to regain
    // stdin before typing the next command (the typed source splits the marker).
    await expect(page.locator(".xterm-rows")).toContainText(
      "PASSPORT_CLAUDE_RETURNED",
    );
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
