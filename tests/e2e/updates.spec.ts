import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeCleanly } from "../fixtures/electron-exit";

let application: ElectronApplication, page: Page, directory: string;
const errors: string[] = [];
let currentVersion: string, nextVersion: string;
const installerName = (version: string) =>
  process.platform === "win32"
    ? `Passport-${version}-win-${process.arch}.exe`
    : `Passport-${version}-mac-arm64.dmg`;

test.beforeEach(async () => {
  errors.length = 0;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-updates-"));
  application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: path.join(directory, "data"),
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  currentVersion = await application.evaluate(({ app }) => app.getVersion());
  const [major, minor, patch] = currentVersion.split(".").map(Number);
  nextVersion = `${major}.${minor}.${patch + 1}`;
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".hosts-view")).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "About", exact: true })
    .click();
});
test.afterEach(async () => {
  try {
    if (application) await closeCleanly(application);
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});

async function mockRelease(
  version: string,
  asset = true,
  delay = 0,
  offline = false,
) {
  await application.evaluate(
    ({ net, shell }, { version, name, asset, delay, offline }) => {
      const state = globalThis as unknown as {
        updateRequests: number;
        updateURLs: string[];
        updateRequest: {
          url: string;
          credentials?: string;
          authorization: boolean;
        };
      };
      state.updateRequests = 0;
      state.updateURLs = [];
      shell.openExternal = async (url) => {
        state.updateURLs.push(url);
      };
      net.fetch = async (url, init) => {
        state.updateRequests++;
        state.updateRequest = {
          url: String(url),
          credentials: init?.credentials,
          authorization: new Headers(init?.headers).has("authorization"),
        };
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (offline) throw new Error("net::ERR_INTERNET_DISCONNECTED");
        return Response.json({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          assets: asset
            ? [
                {
                  name,
                  state: "uploaded",
                  size: 1024,
                  browser_download_url: `https://github.com/poyal/passport/releases/download/v${version}/${name}`,
                },
              ]
            : [],
        });
      };
    },
    { version, name: installerName(version), asset, delay, offline },
  );
}

test("About checks updates, directs downloads to the correct installer, and shows a persistent About shortcut", async ({}, info) => {
  await mockRelease(nextVersion, true, 300);
  await page
    .getByRole("button", { name: "업데이트 확인", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "확인 중…", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".update-result")).toContainText(
    `Passport ${nextVersion} 업데이트가 있습니다.`,
  );
  expect(
    await application.evaluate(() => (globalThis as any).updateRequests),
  ).toBe(1);
  expect(
    await application.evaluate(() => (globalThis as any).updateURLs),
  ).toEqual([]);
  expect(
    await application.evaluate(() => (globalThis as any).updateRequest),
  ).toEqual({
    url: "https://api.github.com/repos/poyal/passport/releases/latest",
    credentials: "omit",
    authorization: false,
  });
  for (const colorMode of ["dark", "light"] as const) {
    await page.evaluate(async (colorMode) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.settings.colorMode = colorMode;
      await window.passport.call("save", document);
    }, colorMode);
    for (const [width, height] of [
      [1440, 900],
      [1024, 680],
    ]) {
      await application.evaluate(
        ({ BrowserWindow }, { width, height }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(width, height),
        { width, height },
      );
      await page.locator(".update-card").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`updates-${colorMode}-${width}.png`),
      });
      const bounds = await page.locator(".update-card").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(
        await page
          .locator(".update-card")
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
    }
  }
  await page
    .getByRole("button", { name: "설치 파일 다운로드", exact: true })
    .click();
  await page
    .getByRole("button", { name: "변경 내역 보기", exact: true })
    .click();
  expect(
    await application.evaluate(() => (globalThis as any).updateURLs),
  ).toEqual([
    `https://github.com/poyal/passport/releases/download/v${nextVersion}/${installerName(nextVersion)}`,
    `https://github.com/poyal/passport/releases/tag/v${nextVersion}`,
  ]);
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page
    .getByRole("button", { name: `새 버전 ${nextVersion}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "About Passport", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".update-result")).toContainText(
    `현재 버전 ${currentVersion}`,
  );
  await expect(page.locator(".update-result")).toContainText(
    `최신 공개 버전 ${nextVersion}`,
  );
  await expect(
    page.evaluate(() =>
      window.passport.call("updates.open", { target: "arbitrary" } as any),
    ),
  ).rejects.toThrow();
});

test("an ahead-of-release installation never offers a downgrade", async () => {
  await mockRelease("1.0.0");
  await page
    .getByRole("button", { name: "업데이트 확인", exact: true })
    .click();
  await expect(page.locator(".update-result")).toContainText(
    "최신 공개 버전(1.0.0)보다 새 버전",
  );
  await expect(
    page.getByRole("button", { name: "설치 파일 다운로드", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".update-notice")).toHaveCount(0);
  await expect(
    page.evaluate(() =>
      window.passport.call("updates.open", { target: "download" }),
    ),
  ).rejects.toThrow();
});

test("an offline check stays inside About while the host screen remains usable", async ({}, info) => {
  await mockRelease(nextVersion, true, 0, true);
  await page
    .getByRole("button", { name: "업데이트 확인", exact: true })
    .click();
  await expect(page.locator(".update-result.error")).toContainText(
    "인터넷 연결",
  );
  await expect(
    page.getByRole("button", { name: "업데이트 확인", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await page
    .locator(".update-card")
    .screenshot({ path: info.outputPath("updates-offline.png") });
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "새 호스트", exact: true }),
  ).toBeVisible();
});

test("a release without an installer offers notes without a broken download button", async () => {
  await mockRelease(nextVersion, false);
  await page
    .getByRole("button", { name: "업데이트 확인", exact: true })
    .click();
  await expect(page.locator(".update-result")).toContainText(
    "설치 파일은 아직 게시되지 않았습니다",
  );
  await expect(
    page.getByRole("button", { name: "설치 파일 다운로드", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "변경 내역 보기", exact: true })
    .click();
  expect(
    await application.evaluate(() => (globalThis as any).updateURLs),
  ).toEqual([`https://github.com/poyal/passport/releases/tag/v${nextVersion}`]);
});
