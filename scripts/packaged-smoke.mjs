import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
const executable = process.argv[2];
if (!executable) throw new Error("패키징된 실행 파일 경로를 입력하세요.");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-package-"));
let app, page;
let phase = "launch";
const watchdog = setTimeout(() => {
  console.error("패키지 실행 검증이 45초 안에 끝나지 않았습니다.", {
    phase,
    directory,
  });
  if (process.platform === "win32") {
    // Only the verification-owned process tree is terminated. If launch has
    // not returned yet, Electron is still a child of this harness process.
    spawnSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/taskkill.exe",
      ),
      ["/PID", String(app?.process().pid || process.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 5000 },
    );
  } else app?.process().kill("SIGKILL");
  // A killed Electron process can leave pending Playwright protocol calls.
  // Fail the harness even when close() never resolves.
  process.exit(1);
}, 45000);
watchdog.unref();
try {
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: directory,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
    timeout: 30000,
  });
  phase = "first window";
  page = await app.firstWindow({ timeout: 30000 });
  // Install the close-dialog answer before assertions so failures can also
  // shut down active PTYs normally instead of waiting for the watchdog.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  page.setDefaultTimeout(15000);
  phase = "home view";
  await page.waitForSelector(".home-view");
  const runtime = await app.evaluate(({ app }) => ({
    appVersion: app.getVersion(),
    arch: process.arch,
    platform: process.platform,
  }));
  if (runtime.platform === "darwin" && runtime.arch !== "arm64")
    throw new Error("Mac 설치본은 Apple Silicon 네이티브여야 합니다.");
  phase = "bootstrap and profile";
  const state = await page.evaluate(async () => {
    const b = await window.passport.call("bootstrap");
    b.document.settings.terminal.profileIds = ["unix-shortcuts"];
    b.document.settings.terminal.shell =
      b.platform === "win32" ? "passport-bash" : "zsh";
    await window.passport.call("save", b.document);
    return {
      hosts: b.document.hosts.length,
      fonts: b.fonts.length,
      version: b.document.version,
      nodeAvailable: typeof window.require !== "undefined",
    };
  });
  if (state.hosts !== 0 || state.version !== 2 || state.nodeAvailable)
    throw new Error("패키징 검증 실패");
  phase = "terminal startup";
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await page.waitForFunction(async () =>
    (await window.passport.call("bootstrap")).sessionStates.some(
      (s) => s.status === "connected" && s.environment?.status === "ready",
    ),
  );
  phase = "terminal input";
  await page.locator(".view:not([hidden]) .xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'PACKAGED_%s\\n' PTY_OK");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".view:not([hidden]) .xterm-rows")
      ?.textContent?.includes("PACKAGED_PTY_OK"),
  );
  phase = "shutdown";
  const exited = once(app.process(), "exit");
  await app.close();
  const [exitCode, signal] = await exited;
  app = undefined;
  assert.deepEqual({ exitCode, signal }, { exitCode: 0, signal: null });
  console.log(
    JSON.stringify({
      packagedSmoke: "passed",
      localPTY: "passed",
      bundledHelper: "passed",
      shutdown: "passed",
      exitCode,
      ...runtime,
      ...state,
    }),
  );
} catch (error) {
  if (page && !page.isClosed())
    console.error(
      "Package UI diagnostic",
      await page
        .evaluate(() => ({
          activeTabs: [...document.querySelectorAll(".app-tab.active")].map(
            (e) => e.textContent,
          ),
          views: [...document.querySelectorAll(".view")].map((e) => ({
            hidden: e.hidden,
            terminals: e.querySelectorAll(".xterm").length,
          })),
        }))
        .catch(() => null),
    );
  throw error;
} finally {
  try {
    if (app) await app.close();
  } finally {
    clearTimeout(watchdog);
    await fs.rm(directory, { recursive: true, force: true });
  }
}
