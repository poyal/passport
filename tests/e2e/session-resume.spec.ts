import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { electron } from "../../scripts/e2e-electron.mjs";
import { closeCleanly } from "../fixtures/electron-exit";
const sh = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const boot = (page: Page) =>
  page.evaluate(() => window.passport.call("bootstrap", undefined));
const ready = (page: Page, id: string) =>
  expect
    .poll(
      async () =>
        (await boot(page)).sessionStates.find((s) => s.id === id)?.environment
          ?.status,
    )
    .toBe("ready");
const input = (page: Page, id: string, data: string) =>
  page.evaluate((args) => window.passport.call("session.input", args), {
    id,
    data: data + "\r",
  });

test("restores history and cwd only when a saved tab is selected and preserves explicit disconnects", async () => {
  const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "passport-resume-ui-")),
    ),
    project = path.join(dir, "한글 project"),
    startup = path.join(dir, "startup");
  await fs.mkdir(project);
  await fs.mkdir(startup);
  await fs.writeFile(
    path.join(startup, ".zshrc"),
    "HISTFILE=/dev/null\nPROMPT='RESUME_READY > '\n",
  );
  const launch = () =>
    electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: path.join(dir, "app"),
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
        ZDOTDIR: startup,
      },
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    await page.evaluate(async (cwd) => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.sessionResume = true;
      Object.assign(b.document.settings.terminal, {
        shell: b.platform === "win32" ? "pwsh" : "zsh",
        cwd,
        profileIds: [],
        autoLogLocal: true,
      });
      await window.passport.call("save", b.document);
    }, dir);
    const targets: { paneId: string; workspaceId: string }[] = [];
    for (const name of ["Resume A", "Resume B"]) {
      const target = await page.evaluate(() =>
        window.passport.call("terminal.create", undefined),
      );
      targets.push(target);
      await page.evaluate(
        async ({ target, name }) => {
          const b = await window.passport.call("bootstrap", undefined),
            w = b.document.workspaces.find((w) => w.id === target.workspaceId)!;
          w.name = name;
          await window.passport.call("save", b.document);
          if (w.root.kind !== "pane") throw new Error();
          await window.passport.call("session.connect", {
            id: target.paneId,
            hostId: w.root.hostId,
          });
        },
        { target, name },
      );
      await page.getByRole("button", { name, exact: true }).click();
      await ready(page, target.paneId);
      const letter = name.slice(-1);
      await input(
        page,
        target.paneId,
        process.platform === "win32"
          ? `Set-Location -LiteralPath ${ps(project)}; Write-Output ('HISTORY_' + '${letter}')`
          : `cd -- ${sh(project)}; printf 'HISTORY_%s\\n' ${letter}`,
      );
      await expect(
        page.locator(".view:not([hidden]) .xterm-rows"),
      ).toContainText("HISTORY_" + letter);
    }
    await page.getByRole("button", { name: "Resume A", exact: true }).click();
    const originalGroup = await page.evaluate(
      async (id) =>
        (await window.passport.call("logs.groups", undefined)).find((g) =>
          g.segments.some((s) => s.sessionId === id),
        )!,
      targets[0].paneId,
    );
    await closeCleanly(application);
    application = await launch();
    page = await application.firstWindow();
    await ready(page, targets[0].paneId);
    let b = await boot(page);
    expect(
      b.sessionStates.filter((s) => s.status === "connected").map((s) => s.id),
    ).toEqual([targets[0].paneId]);
    expect(b.sessionStates[0].environment?.cwd).toBe(project);
    await expect(page.locator(".view:not([hidden]) .xterm-rows")).toContainText(
      "HISTORY_A",
    );
    await input(
      page,
      targets[0].paneId,
      process.platform === "win32"
        ? "Write-Output ('AFTER_' + 'A')"
        : "printf 'AFTER_%s\\n' A",
    );
    await expect
      .poll(async () =>
        page.evaluate(async (groupId) => {
          const group = (
            await window.passport.call("logs.groups", undefined)
          ).find((g) => g.id === groupId)!;
          return (
            await window.passport.call("logs.read", {
              id: group.segments.at(-1)!.id,
              plain: true,
            })
          ).text;
        }, originalGroup.id),
      )
      .toContain("AFTER_A");
    const restoredLog = await page.evaluate(async (groupId) => {
      const group = (await window.passport.call("logs.groups", undefined)).find(
        (g) => g.id === groupId,
      )!;
      return {
        group,
        latest: await window.passport.call("logs.read", {
          id: group.segments.at(-1)!.id,
          plain: true,
        }),
      };
    }, originalGroup.id);
    expect(restoredLog.group.segments).toHaveLength(
      originalGroup.segments.length + 1,
    );
    expect(restoredLog.group.segments.at(-1)?.reason).toBe("resume");
    expect(restoredLog.latest.text).not.toContain("HISTORY_A");
    await page.getByRole("button", { name: "Resume B", exact: true }).click();
    await ready(page, targets[1].paneId);
    expect(
      (await boot(page)).sessionStates.find((s) => s.id === targets[1].paneId)
        ?.environment?.cwd,
    ).toBe(project);
    await expect(page.locator(".view:not([hidden]) .xterm-rows")).toContainText(
      "HISTORY_B",
    );
    await page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      targets[1].paneId,
    );
    await page.reload();
    await expect
      .poll(
        async () =>
          (await boot(page)).resumeSessions.find(
            (s) => s.id === targets[1].paneId,
          )?.automatic,
      )
      .toBe(false);
    expect(
      (await boot(page)).sessionStates.find((s) => s.id === targets[1].paneId)
        ?.status,
    ).not.toBe("connected");
    await expect(
      page.locator(".view:not([hidden]) .xterm-rows"),
    ).not.toContainText("HISTORY_B");
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await ready(page, targets[1].paneId);
    const text = await page
      .locator(".view:not([hidden]) .xterm-rows")
      .innerText();
    expect(text.split("HISTORY_B")).toHaveLength(2);
    await page.evaluate(async () => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.sessionResume = false;
      await window.passport.call("save", b.document);
    });
    expect((await boot(page)).resumeSessions).toEqual([]);
    // Switching resume off leaves the recorded group available, including both connection intervals.
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "세션 로그", exact: true }).click();
    await page.locator(`[data-log-group-id="${originalGroup.id}"]`).click();
    await expect(page.getByLabel("세션 로그 내용")).toContainText("HISTORY_A");
    await expect(page.getByLabel("세션 로그 내용")).toContainText("AFTER_A");
    await expect(page.getByLabel("세션 로그 내용")).toContainText(
      "이전 터미널 복원 후 연결",
    );
    await page.getByLabel("로그 검색").fill("AFTER_A");
    await page
      .locator(".log-reader")
      .getByRole("button", { name: "검색", exact: true })
      .click();
    await expect(page.getByLabel("세션 로그 내용")).toContainText("AFTER_A");
    await expect(page.getByLabel("세션 로그 내용")).not.toContainText(
      "HISTORY_A",
    );
    const exported = path.join(dir, "group.log");
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: destination,
      });
    }, exported);
    await page
      .locator(".log-reader")
      .getByRole("button", { name: "내보내기", exact: true })
      .click();
    await expect
      .poll(async () => fs.readFile(exported, "utf8").catch(() => ""))
      .toContain("HISTORY_A");
    expect(await fs.readFile(exported, "utf8")).toContain("AFTER_A");
    await page
      .getByLabel("조회 구간")
      .selectOption(restoredLog.group.segments.at(-1)!.id);
    await page
      .locator(".log-reader")
      .getByRole("button", { name: "내보내기", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await fs.readFile(exported, "utf8")).includes("HISTORY_A"),
      )
      .toBe(false);
    expect(await fs.readFile(exported, "utf8")).toContain("AFTER_A");
  } finally {
    await closeCleanly(application);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resumes each local AI with its exact conversation and explicit options without repeating initial input", async () => {
  const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "passport-resume-ai-")),
    ),
    bin = path.join(dir, "bin"),
    startup = path.join(dir, "startup");
  await fs.mkdir(bin);
  await fs.mkdir(startup);
  await fs.writeFile(
    path.join(startup, ".zshrc"),
    "HISTFILE=/dev/null\nPROMPT='AI_READY > '\n",
  );
  const capture = path.join(dir, "capture.jsonl"),
    script = path.join(dir, "codex.cjs");
  await fs.writeFile(
    script,
    `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--no-daemon'); process.exit(0); }
const args = process.argv.slice(2), resume = args.indexOf('resume');
const id = resume >= 0 && args[resume+1] && !args[resume+1].startsWith('-') ? args[resume+1] : process.env.PASSPORT_GENERATION;
const helper = process.platform === 'win32' ? 'passport-helper.exe' : 'passport-helper';
cp.execFileSync(helper, ['codex-hook'], {input:JSON.stringify({hook_event_name:'SessionStart',session_id:id,cwd:process.cwd()})});
let input = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { input += data; if (input.includes('exit')) process.exit(0); });
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({id,args,cwd:process.cwd(),pid:process.pid,paneId:process.env.PASSPORT_PANE_ID})+'\\n');
console.log('AGENT_RUNNING:'+id);
console.log('AGENT_READY:'+process.pid);
setInterval(()=>{},1000);
`,
  );
  await fs.writeFile(
    path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex"),
    process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(script)} "$@"\n`,
    { mode: 0o755 },
  );
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: path.join(dir, "app"),
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
      ZDOTDIR: startup,
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    // This test checks the encryption boundary, not OS Keychain/DPAPI behavior.
    await application.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) =>
        Buffer.from(Buffer.from(value).toString("base64"));
      safeStorage.decryptString = (value) =>
        Buffer.from(value.toString(), "base64").toString();
    });
    await page.evaluate(
      async ({ dir, bin }) => {
        const b = await window.passport.call("bootstrap", undefined),
          shell = b.platform === "win32" ? "pwsh" : "zsh";
        b.document.settings.sessionResume = true;
        Object.assign(b.document.settings.terminal, {
          shell,
          cwd: dir,
          profileIds: ["resume-fixture"],
        });
        b.document.settings.terminal.profiles.push({
          id: "resume-fixture",
          name: "Fixture",
          revision: 1,
          origin: "user",
          platforms: ["darwin", "win32"],
          shells: ["zsh", "pwsh"],
          entries: [{ kind: "path", value: bin, position: "prepend" }],
        });
        await window.passport.call("save", b.document);
      },
      { dir, bin },
    );
    const targets: { paneId: string; hostId: string }[] = [];
    for (const command of [
      "codex",
      "codex -a never -s danger-full-access resume",
    ]) {
      const target = await page.evaluate(async () => {
        const t = await window.passport.call("terminal.create", undefined);
        const b = await window.passport.call("bootstrap", undefined),
          w = b.document.workspaces.find((w) => w.id === t.workspaceId)!;
        if (w.root.kind !== "pane") throw new Error();
        const target = { paneId: t.paneId, hostId: w.root.hostId };
        await window.passport.call("session.connect", {
          id: target.paneId,
          hostId: target.hostId,
        });
        return target;
      });
      targets.push(target);
      await page.locator(".workspace-select").last().click();
      await ready(page, target.paneId);
      await input(page, target.paneId, command);
      await expect(
        page.locator(".view:not([hidden]) .xterm-rows"),
      ).toContainText("AGENT_RUNNING:");
    }
    const captures = async () =>
      (await fs.readFile(capture, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (s) =>
            JSON.parse(s) as {
              id: string;
              args: string[];
              cwd: string;
              pid: number;
              paneId: string;
            },
        );
    await expect.poll(async () => (await captures()).length).toBe(2);
    const originals = await captures();
    for (const target of targets) {
      await page.evaluate(async (target) => {
        await window.passport.call("session.close", { id: target.paneId });
        await window.passport.call("session.connect", {
          id: target.paneId,
          hostId: target.hostId,
        });
      }, target);
    }
    await expect.poll(async () => (await captures()).length).toBe(4);
    // Both shells start asynchronously. Match captures to their owning panes;
    // process readiness order is not a session restoration contract.
    const resumedCaptures = (await captures()).slice(2);
    expect(resumedCaptures.map((r) => r.paneId).sort()).toEqual(
      targets.map((target) => target.paneId).sort(),
    );
    const resumed = targets.map((target) =>
      resumedCaptures.find((r) => r.paneId === target.paneId)!,
    );
    expect(resumed.map((r) => r.id)).toEqual(originals.map((r) => r.id));
    expect(resumed[0].args).not.toContain("-a");
    expect(resumed[1].args.slice(-8)).toEqual([
      "-a",
      "never",
      "-s",
      "danger-full-access",
      "resume",
      originals[1].id,
      "--cd",
      dir,
    ]);
    // The capture is written after stdin is installed; the PID marker must
    // come from the resumed process, never from the restored old scrollback.
    await expect(page.locator(".view:not([hidden]) .xterm-rows")).toContainText(
      `AGENT_READY:${resumed[1].pid}`,
    );
    await input(page, targets[1].paneId, "exit");
    await expect
      .poll(async () =>
        (
          await page.locator(".view:not([hidden]) .xterm-rows").innerText()
        ).trim(),
      )
      .toMatch(/(?:AI_READY >|PS [^\r\n]*>)$/);
    await input(
      page,
      targets[1].paneId,
      process.platform === "win32"
        ? "Write-Output ('AGENT_' + 'EXITED')"
        : "printf 'AGENT_%s\\n' EXITED",
    );
    await expect(page.locator(".xterm-rows").last()).toContainText(
      "AGENT_EXITED",
    );
    await page.evaluate(async (t) => {
      await window.passport.call("session.close", { id: t.paneId });
      await window.passport.call("session.connect", {
        id: t.paneId,
        hostId: t.hostId,
      });
    }, targets[1]);
    await ready(page, targets[1].paneId);
    expect((await captures()).length).toBe(4);
    expect(
      await page.evaluate(() =>
        window.passport.call("activity.list", undefined),
      ),
    ).toEqual([]);
  } finally {
    await closeCleanly(application);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("applies resume to existing terminals and restores Codex and Claude after a full app restart with CLI access off", async () => {
  const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "passport-resume-restart-")),
    ),
    bin = path.join(dir, "bin"),
    startup = path.join(dir, "startup"),
    capture = path.join(dir, "capture.jsonl"),
    script = path.join(dir, "agent.cjs");
  await fs.mkdir(bin);
  await fs.mkdir(startup);
  await fs.writeFile(
    path.join(startup, ".zshrc"),
    `HISTFILE=/dev/null\nPROMPT='RESTART_READY > '\nexport PATH=${sh(bin)}:"$PATH"\n`,
  );
  await fs.writeFile(
    script,
    `
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
if (process.argv.includes('--version')) { console.log('agent fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--no-daemon'); process.exit(0); }
const [agent, ...args] = process.argv.slice(2);
const selector = args.indexOf(agent === 'codex' ? 'resume' : '--resume');
const id = selector >= 0 && args[selector + 1] && !args[selector + 1].startsWith('-') ? args[selector + 1] : crypto.randomUUID();
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({agent,id,args})+'\\n');
if (process.env.PASSPORT_RESUME === '1') {
  const helper = process.platform === 'win32' ? 'passport-helper.exe' : 'passport-helper';
  cp.execFileSync(helper, [agent+'-hook'], {input:JSON.stringify({hook_event_name:'SessionStart',session_id:id,cwd:process.cwd()})});
}
console.log('RESTART_AGENT:'+agent+':'+id);
process.stdin.resume();
setInterval(()=>{},1000);
`,
  );
  for (const agent of ["codex", "claude"])
    await fs.writeFile(
      path.join(bin, agent + (process.platform === "win32" ? ".cmd" : "")),
      process.platform === "win32"
        ? `@"${process.execPath}" "${script}" ${agent} %*\r\n`
        : `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(script)} ${agent} "$@"\n`,
      { mode: 0o755 },
    );
  const launch = () =>
    electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        // Model a desktop app launched inside an already integrated Passport pane.
        PASSPORT_RESUME: "1",
        PASSPORT_AGENT_RUN: "parent-agent-run",
        PASSPORT_DATA_DIR: path.join(dir, "app"),
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
        ZDOTDIR: startup,
      },
    });
  const captures = async () =>
    (await fs.readFile(capture, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map(
        (s) => JSON.parse(s) as { agent: string; id: string; args: string[] },
      );
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    // Real app restart: use the app's normal encryption/decryption on both launches.
    expect(
      await application.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable(),
      ),
    ).toBe(true);
    await page.evaluate(async (dir) => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.sessionResume = false;
      Object.assign(b.document.settings.terminal, {
        shell: b.platform === "win32" ? "pwsh" : "default",
        cwd: dir,
        profileIds: [],
        cliAccess: "off",
      });
      b.document.settings.notifications.codex = false;
      b.document.settings.notifications.claude = false;
      await window.passport.call("save", b.document);
    }, dir);
    const targets: {
      paneId: string;
      workspaceId: string;
      hostId: string;
      agent: string;
    }[] = [];
    for (const agent of ["codex", "claude"]) {
      const target = await page.evaluate(async (agent) => {
        const t = await window.passport.call("terminal.create", undefined);
        const b = await window.passport.call("bootstrap", undefined);
        const w = b.document.workspaces.find((w) => w.id === t.workspaceId)!;
        w.name = "Restart " + agent;
        if (w.root.kind !== "pane") throw new Error();
        await window.passport.call("save", b.document);
        await window.passport.call("session.connect", {
          id: t.paneId,
          hostId: w.root.hostId,
        });
        return { ...t, hostId: w.root.hostId, agent };
      }, agent);
      targets.push(target);
      await page
        .getByRole("button", { name: "Restart " + agent, exact: true })
        .click();
      await ready(page, target.paneId);
      await input(page, target.paneId, agent);
      await expect(
        page.locator(".view:not([hidden]) .xterm-rows"),
      ).toContainText("RESTART_AGENT:" + agent);
    }
    await page.evaluate(async () => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.sessionResume = true;
      await window.passport.call("save", b.document);
    });
    const states = (await boot(page)).sessionStates;
    expect(states.every((s) => s.resumeNeedsReconnect)).toBe(true);
    await page.getByRole("button", { name: "복원 적용", exact: true }).click();
    await page.getByRole("button", { name: "취소", exact: true }).click();
    expect((await boot(page)).sessionStates.map((s) => s.generation)).toEqual(
      states.map((s) => s.generation),
    );
    expect(await captures()).toHaveLength(2);
    for (const target of targets) {
      await page
        .getByRole("button", { name: "Restart " + target.agent, exact: true })
        .click();
      await page
        .getByRole("button", { name: "복원 적용", exact: true })
        .click();
      await page.getByRole("button", { name: "확인", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await boot(page)).sessionStates.find((s) => s.id === target.paneId)
              ?.resumeNeedsReconnect,
        )
        .toBe(false);
      await ready(page, target.paneId);
    }
    // OFF/ON must keep the credentials of already integrated live shells.
    for (const enabled of [false, true])
      await page.evaluate(async (enabled) => {
        const b = await window.passport.call("bootstrap", undefined);
        b.document.settings.sessionResume = enabled;
        await window.passport.call("save", b.document);
      }, enabled);
    expect(
      (await boot(page)).sessionStates.every((s) => !s.resumeNeedsReconnect),
    ).toBe(true);
    for (const target of targets) {
      await page
        .getByRole("button", { name: "Restart " + target.agent, exact: true })
        .click();
      await input(
        page,
        target.paneId,
        target.agent === "codex"
          ? "codex -a never -s danger-full-access resume"
          : "claude --permission-mode plan",
      );
    }
    await expect.poll(async () => (await captures()).length).toBe(4);
    const originals = (await captures()).slice(2);
    // Seeing the marker guarantees the native helper's hook ACK has completed.
    for (const target of targets) {
      await page
        .getByRole("button", { name: "Restart " + target.agent, exact: true })
        .click();
      await expect(
        page.locator(".view:not([hidden]) .xterm-rows"),
      ).toContainText(
        "RESTART_AGENT:" +
          target.agent +
          ":" +
          originals.find((r) => r.agent === target.agent)!.id,
      );
    }
    await closeCleanly(application);
    application = await launch();
    page = await application.firstWindow();
    // Only the previously selected Claude tab reconnects initially.
    await expect.poll(async () => (await captures()).length).toBe(5);
    await page
      .getByRole("button", { name: "Restart codex", exact: true })
      .click();
    await expect.poll(async () => (await captures()).length).toBe(6);
    const resumed = (await captures()).slice(4);
    for (const original of originals) {
      const actual = resumed.find((r) => r.agent === original.agent)!;
      expect(actual.id).toBe(original.id);
      if (original.agent === "codex")
        expect(actual.args.slice(-8)).toEqual([
          "-a",
          "never",
          "-s",
          "danger-full-access",
          "resume",
          original.id,
          "--cd",
          dir,
        ]);
      else
        expect(actual.args.slice(-4)).toEqual([
          "--permission-mode",
          "plan",
          "--resume",
          original.id,
        ]);
    }
    expect(
      await page.evaluate(() =>
        window.passport.call("activity.list", undefined),
      ),
    ).toEqual([]);
  } finally {
    await closeCleanly(application);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
