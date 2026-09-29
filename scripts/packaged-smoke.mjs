import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
const executable = process.argv[2];
if (!executable) throw new Error("패키징된 실행 파일 경로를 입력하세요.");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-package-"));
let app, page;
const watchdog = setTimeout(() => {
  console.error("패키지 실행 검증이 45초 안에 끝나지 않았습니다.");
  app?.process().kill("SIGKILL");
}, 45000);
watchdog.unref();
try {
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: { ...process.env, PASSPORT_DATA_DIR: directory },
    timeout: 30000,
  });
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
  await page.waitForSelector(".hosts-view");
  const runtime = await app.evaluate(({ app }) => ({
    appVersion: app.getVersion(),
    arch: process.arch,
    platform: process.platform,
  }));
  if (runtime.platform === "darwin" && runtime.arch !== "arm64")
    throw new Error("Mac 설치본은 Apple Silicon 네이티브여야 합니다.");
  const state = await page.evaluate(async () => {
    const b = await window.passport.call("bootstrap");
    return {
      hosts: b.document.hosts.length,
      fonts: b.fonts.length,
      version: b.document.version,
      nodeAvailable: typeof window.require !== "undefined",
    };
  });
  if (state.hosts !== 0 || state.version !== 1 || state.nodeAvailable)
    throw new Error("패키징 검증 실패");
  await page.getByRole("button", { name: "새 SSH 탭", exact: true }).click();
  await page
    .getByRole("button", { name: "로컬 터미널 열기", exact: true })
    .click();
  await page.waitForFunction(async () =>
    (await window.passport.call("bootstrap")).sessionStates.some(
      (s) => s.status === "connected",
    ),
  );
  await page.locator(".view:not([hidden]) .xterm-helper-textarea").focus();
  await page.keyboard.type(
    runtime.platform === "win32"
      ? "echo PACKAGED_PTY_OK"
      : "printf 'PACKAGED_%s\\n' PTY_OK",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".view:not([hidden]) .xterm-rows")
      ?.textContent?.includes("PACKAGED_PTY_OK"),
  );
  const exited = once(app.process(), "exit");
  await app.close();
  const [exitCode, signal] = await exited;
  app = undefined;
  assert.deepEqual({ exitCode, signal }, { exitCode: 0, signal: null });
  console.log(
    JSON.stringify({
      packagedSmoke: "passed",
      localPTY: "passed",
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
