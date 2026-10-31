import { test, expect } from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";
import { hostSchema } from "../../src/shared/model";
import { randomUUID } from "node:crypto";

const suite = reusableApp({ name: "failure-recovery" });
async function rejectNextSave() {
  await suite.application.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get("passport:call");
    let pending = true;
    ipcMain.removeHandler("passport:call");
    ipcMain.handle("passport:call", (event, name, input) => {
      if (name === "save" && pending) {
        pending = false;
        return { ok: false, error: "시험 저장 실패: 다시 시도하세요." };
      }
      return original(event, name, input);
    });
  });
}
async function existingHost() {
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "보존할 호스트",
    address: "127.0.0.1",
    username: "tester",
  });
  await suite.page.evaluate(async (host) => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.hosts = [host];
    await window.passport.call("save", document);
  }, host);
  await suite.page.getByRole("button", { name: "호스트", exact: true }).click();
  await suite.page.locator(".host-row").filter({ hasText: host.name }).click();
  return host;
}
test("failed host saves retain draft values and allow one successful retry", async () => {
  const host = await existingHost(),
    { page } = suite;
  await page
    .getByLabel("이름", { exact: true })
    .fill("저장 실패 후 재시도 한글 💻");
  await rejectNextSave();
  await page.getByRole("button", { name: "호스트 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("시험 저장 실패");
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue(
    "저장 실패 후 재시도 한글 💻",
  );
  expect(
    (await page.evaluate(() => window.passport.call("bootstrap", undefined)))
      .document.hosts[0].name,
  ).toBe(host.name);
  await page.getByRole("button", { name: "호스트 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("호스트를 저장했습니다");
  await page.reload();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await expect(page.locator(".host-row")).toContainText(
    "저장 실패 후 재시도 한글 💻",
  );
});
test("failed host deletion keeps the selected draft and cancel preserves the stored host", async () => {
  const host = await existingHost(),
    { page } = suite;
  await page
    .getByLabel("이름", { exact: true })
    .fill("아직 저장하지 않은 수정");
  await rejectNextSave();
  await page.getByRole("button", { name: "호스트 삭제", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "확인", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("시험 저장 실패");
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue(
    "아직 저장하지 않은 수정",
  );
  expect(
    (
      await page.evaluate(() => window.passport.call("bootstrap", undefined))
    ).document.hosts.map((h) => h.id),
  ).toEqual([host.id]);
  await page.getByRole("button", { name: "호스트 삭제", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue(
    "아직 저장하지 않은 수정",
  );
});
test("a stale document cannot overwrite another window's saved settings", async () => {
  const { page } = suite;
  const initial = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  await page.evaluate(async () => {
    const { document } = await window.passport.call("bootstrap", undefined);
    document.settings.colorMode = "light";
    await window.passport.call("save", document);
  });
  await expect(
    page.evaluate(
      (document) => window.passport.call("save", document),
      initial.document,
    ),
  ).rejects.toThrow();
  expect(
    (await page.evaluate(() => window.passport.call("bootstrap", undefined)))
      .document.settings.colorMode,
  ).toBe("light");
});
test("save cancellation reports no completion and creates no export", async () => {
  const { page, application } = suite;
  await application.evaluate(({ dialog }) => {
    (globalThis as any).__cancelledExports = 0;
    dialog.showSaveDialog = async () => {
      (globalThis as any).__cancelledExports++;
      return { canceled: true, filePath: "" };
    };
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByRole("button", { name: "내보내기와 백업", exact: true })
    .click();
  const before = (
    await page.evaluate(() => window.passport.call("bootstrap", undefined))
  ).document;
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  await expect
    .poll(() =>
      application.evaluate(() => (globalThis as any).__cancelledExports),
    )
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "내보내기", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "내보내기를 완료했습니다" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.passport.call("bootstrap", undefined)))
      .document,
  ).toEqual(before);
});
