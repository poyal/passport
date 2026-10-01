import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";

test("legacy SSH works without a host option for terminal and SFTP, and first-key confirmation can be disabled", async ({}, info) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-legacy-ui-"),
  );
  const server = await sshFixture(directory, {
    kex: ["diffie-hellman-group1-sha1"],
    serverHostKey: ["ssh-rsa"],
    cipher: ["aes128-ctr"],
    hmac: ["hmac-sha1"],
  });
  const app = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "호스트", exact: true }).click();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".hosts-view")).toBeVisible();
    const version = await app.evaluate(({ app }) => app.getVersion());
    await expect(page.locator(".app-status")).toContainText(
      `Passport ${version}`,
    );
    await app.evaluate(({ dialog, safeStorage }) => {
      (globalThis as any).trustPromptCount = 0;
      dialog.showMessageBox = async (...args: any[]) => {
        if (args.at(-1)?.title === "SSH 호스트 키 확인")
          (globalThis as any).trustPromptCount++;
        return { response: 1, checkboxChecked: false };
      };
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (text) => Buffer.from(text);
      safeStorage.decryptString = (buffer) => buffer.toString();
    });
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page
      .getByRole("button", { name: "인증 프로필", exact: true })
      .click();
    await page.getByRole("tab", { name: "SSH 호스트 키", exact: true }).click();
    await expect(page.getByLabel("첫 연결 지문 확인창 표시")).toBeChecked();
    await page.getByRole("tab", { name: "SSH 호스트 키", exact: true }).click();
    await page.getByLabel("첫 연결 지문 확인창 표시").click();
    await expect(page.getByLabel("첫 연결 지문 확인창 표시")).not.toBeChecked();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.passport.call("bootstrap", undefined),
            )
          ).document.settings.confirmNewHostKeys,
      )
      .toBe(false);
    await page.getByRole("button", { name: "호스트", exact: true }).click();
    await page.getByRole("button", { name: "새 호스트", exact: true }).click();
    await page.getByLabel("이름", { exact: true }).fill("구형 SSH 검증");
    await page.getByLabel("서버 주소", { exact: true }).fill("127.0.0.1");
    await page.getByLabel("포트", { exact: true }).fill(String(server.port));
    await page.getByLabel("사용자 이름", { exact: true }).fill("tester");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("test-only-password");
    await expect(page.getByLabel("SSH 알고리즘")).toHaveCount(0);
    await page
      .getByRole("button", { name: "호스트 저장", exact: true })
      .click();
    await expect(page.locator(".host-row")).toHaveCount(1);
    await page.getByRole("button", { name: "SSH 연결", exact: true }).click();
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "1 / 1 연결",
    );
    await expect.poll(() => server.shells.length).toBe(1);
    server.input.splice(0);
    await page
      .locator(".view:not([hidden]) .xterm-helper-textarea")
      .fill("구형 서버 입력 검증");
    await expect
      .poll(() => server.input.join(""))
      .toContain("구형 서버 입력 검증");
    expect(server.negotiated.at(-1)?.kex).toBe("diffie-hellman-group1-sha1");
    await page.screenshot({ path: info.outputPath("legacy-terminal.png") });
    await page.getByRole("button", { name: "호스트", exact: true }).click();
    await page
      .getByRole("button", { name: "파일 오른쪽", exact: true })
      .click();
    await expect(page.getByLabel("오른쪽 경로", { exact: true })).toHaveValue(
      "/",
    );
    expect(await app.evaluate(() => (globalThis as any).trustPromptCount)).toBe(
      0,
    );
    await page.reload();
    const saved = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    expect(saved.document.hosts[0]).not.toHaveProperty("legacySSH");
    expect(saved.document.settings.confirmNewHostKeys).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await closeCleanly(app);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
