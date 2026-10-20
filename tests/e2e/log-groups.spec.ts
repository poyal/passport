import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { reusableApp } from "../fixtures/reusable-app";
import { sshFixture } from "../fixtures/ssh-server";
import { hostSchema } from "../../src/shared/model";

const suite = reusableApp({ name: "log-groups" });

test("SSH reconnects keep a log group with visible expired segments and recording gaps", async () => {
  const { application, page, directory } = suite;
  const server = await sshFixture(directory);
  const paneId = randomUUID();
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "SSH 이어진 작업",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
    autoReconnect: true,
  });
  try {
    await page.evaluate(
      async ({ paneId, host }) => {
        const { document } = await window.passport.call("bootstrap", undefined);
        document.settings.confirmNewHostKeys = false;
        document.settings.logRetentionDays = 1;
        document.hosts = [host];
        document.workspaces = [
          {
            id: crypto.randomUUID(),
            name: "SSH 이어진 작업",
            root: { kind: "pane", id: paneId, hostId: host.id },
          },
        ];
        await window.passport.call("save", document);
        await window.passport.call("session.connect", {
          id: paneId,
          hostId: host.id,
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        });
      },
      { paneId, host },
    );
    server.shells[0].write("\r\nBEFORE_SSH\r\n");
    const groups = () =>
      page.evaluate(() => window.passport.call("logs.groups", undefined));
    const read = (id: string) =>
      page.evaluate((id) => window.passport.call("logs.readGroup", { id }), id);
    const groupId = (await groups())[0].id;
    await expect
      .poll(async () => (await read(groupId)).parts.map((p) => p.text).join(""))
      .toContain("BEFORE_SSH");
    server.shells[0].end();
    await expect.poll(() => server.shells.length).toBe(2);
    server.shells[1].write("\r\nAFTER_SSH\r\n");
    await expect
      .poll(async () => (await read(groupId)).parts.map((p) => p.text).join(""))
      .toContain("AFTER_SSH");
    expect(await groups()).toHaveLength(1);
    expect((await groups())[0].segments.map((s) => s.reason)).toEqual([
      "start",
      "reconnect",
    ]);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "세션 로그", exact: true }).click();
    await page.locator(`[data-log-group-id="${groupId}"]`).click();
    await expect(page.getByLabel("세션 로그 내용")).toContainText("BEFORE_SSH");
    await expect(page.getByLabel("세션 로그 내용")).toContainText("AFTER_SSH");
    await expect(page.getByLabel("세션 로그 내용")).toContainText(
      "연결 종료 후 재연결",
    );
    await application.evaluate(() =>
      (globalThis as any).__passportTestAdvanceClock(2 * 86400000),
    );
    server.shells[1].write("\r\nRECENT_SSH\r\n");
    await expect
      .poll(async () => (await read(groupId)).parts.map((p) => p.text).join(""))
      .toContain("RECENT_SSH");
    expect((await groups())[0].expired).toBe(2);
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await page.locator(`[data-log-group-id="${groupId}"]`).click();
    await expect(page.locator(".log-reader")).toContainText(
      "2개 구간이 만료되었습니다",
    );
    await expect(page.getByLabel("세션 로그 내용")).not.toContainText(
      "BEFORE_SSH",
    );
    await page.evaluate(
      (id) => window.passport.call("logs.record", { id, enabled: false }),
      paneId,
    );
    server.shells[1].write("\r\nUNRECORDED_GAP\r\n");
    // Wait until the live terminal has consumed this output before starting recording again.
    await page.locator(".workspace-tab").click();
    await expect(page.locator(".xterm-rows")).toContainText("UNRECORDED_GAP");
    await page.evaluate(
      (id) => window.passport.call("logs.record", { id, enabled: true }),
      paneId,
    );
    server.shells[1].write("\r\nRECORDED_AGAIN\r\n");
    await expect
      .poll(async () => (await read(groupId)).parts.map((p) => p.text).join(""))
      .toContain("RECORDED_AGAIN");
    expect(
      (await read(groupId)).parts.map((p) => p.text).join(""),
    ).not.toContain("UNRECORDED_GAP");
    expect((await groups())[0].segments.at(-1)?.reason).toBe("recording");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "세션 로그", exact: true }).click();
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await page.locator(`[data-log-group-id="${groupId}"]`).click();
    await expect(page.getByLabel("세션 로그 내용")).toContainText(
      "기록하지 않은 구간이 있을 수 있습니다",
    );
  } finally {
    await page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      paneId,
    );
    await server.close();
  }
});
