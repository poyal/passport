import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostSchema } from "../../src/shared/model";
import { themes } from "../../src/shared/themes";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";

test("file types follow every theme while server ANSI, input and output text stay intact", async ({}, info) => {
  test.setTimeout(120000);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-file-colors-"),
  );
  const server = await sshFixture(directory);
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
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    });
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "파일 종류 색상 검증",
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
    });
    const id = randomUUID();
    await page.evaluate(
      async ({ host, id, workspaceId }) => {
        const { document } = await window.passport.call("bootstrap", undefined);
        document.hosts = [host];
        document.workspaces = [
          {
            id: workspaceId,
            name: "파일·폴더 색상",
            root: { kind: "pane", id, hostId: host.id },
          },
        ];
        await window.passport.call("save", document);
      },
      { host, id, workspaceId: randomUUID() },
    );
    await page.locator(".workspace-tab>button").first().click();
    await page.evaluate(
      async ({ id, hostId }) =>
        window.passport.call("session.connect", {
          id,
          hostId,
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        }),
      { id, hostId: host.id },
    );
    await expect.poll(() => server.shells.length).toBe(1);
    const rows = page.locator(".view:not([hidden]) .xterm-rows");
    const listing = [
      "[root@localhost ~]# ll",
      "합계 568",
      "-rw-r--r--. 1 root root 5409 7월 13 01:39 poc_build.log",
      "drwxr-xr-x. 2 root root 4096 7월 19 11:16 logs",
      "-rwxr-xr-x. 1 root root 816 6월 21 18:18 hardware_id.sh",
      "lrwxrwxrwx. 1 root root 4 9월 30 13:10 current -> logs",
      "drwxr-xr-x. 2 root root 4096 2월 25 2026 문서",
      "drwxr-xr-x. 2 root root 4096 Sep 30 13:10 \x1b[38;2;170;55;66mANSI_DIR\x1b[0m",
      "[root@localhost ~]# ",
    ].join("\r\n");
    await page.evaluate((id) => {
      (window as any).__fileColorRaw = "";
      window.passport.onEvent((event) => {
        if (event.kind === "output" && event.id === id)
          (window as any).__fileColorRaw += event.data;
      });
    }, id);
    server.shells[0].write("\x1b[2J\x1b[H" + listing);
    await expect(rows).toContainText("ANSI_DIR");
    const rgb = (hex: string) =>
      `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const colorOf = async (name: string) =>
      rows.evaluate((rows, name) => {
        const row = [...rows.children].find((row) =>
          row.textContent?.includes(name),
        );
        if (!row) return [];
        const start = row.textContent!.indexOf(name);
        let offset = 0;
        const colors = new Set<string>();
        for (const span of row.querySelectorAll("span")) {
          const end = offset + (span.textContent?.length || 0);
          if (end > start && offset < start + name.length)
            colors.add(getComputedStyle(span).color);
          offset = end;
        }
        return [...colors];
      }, name);
    const custom = {
      id: randomUUID(),
      name: "사용자 팔레트",
      source: "사용자 테마",
      theme: {
        ...themes[0].theme,
        blue: "#aa88ff",
        green: "#88dd99",
        cyan: "#88ccdd",
      },
    };
    await page.evaluate(async (theme) => {
      const { document } = await window.passport.call("bootstrap", undefined);
      document.settings.customThemes.push({
        id: theme.id,
        name: theme.name,
        colors: Object.fromEntries(
          Object.entries(theme.theme).filter(
            ([key]) => key !== "selectionInactiveBackground",
          ),
        ) as Record<string, string>,
      });
      await window.passport.call("save", document);
    }, custom);
    for (const theme of [...themes, custom]) {
      await page.evaluate(async (theme) => {
        const { document } = await window.passport.call("bootstrap", undefined);
        document.settings.appearance.theme = theme;
        await window.passport.call("save", document);
      }, theme.id);
      for (const [name, palette] of [
        ["logs", "blue"],
        ["문서", "blue"],
        ["hardware_id.sh", "green"],
        ["current", "cyan"],
        ["poc_build.log", "foreground"],
      ] as const) {
        await expect
          .poll(() => colorOf(name))
          .toEqual([rgb(theme.theme[palette]!)]);
      }
      expect(await colorOf("ANSI_DIR")).toEqual(["rgb(170, 55, 66)"]);
      await page.screenshot({
        path: info.outputPath(`file-colors-${theme.id}.png`),
      });
    }
    // Disable through the actual settings control, then return to the terminal.
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("tab", { name: "터미널 설정", exact: true }).click();
    await expect(
      page.getByLabel("파일·폴더 색상 구분", { exact: true }),
    ).toBeChecked();
    await page.getByLabel("파일·폴더 색상 구분", { exact: true }).click();
    await expect(
      page.getByLabel("파일·폴더 색상 구분", { exact: true }),
    ).not.toBeChecked();
    await page.locator(".workspace-tab>button").first().click();
    await expect(
      page.locator(".view:not([hidden]) .xterm-decoration"),
    ).toHaveCount(0);
    expect(await colorOf("ANSI_DIR")).toEqual(["rgb(170, 55, 66)"]);
    const raw = await page.evaluate(
      () => (window as any).__fileColorRaw as string,
    );
    expect(raw).toContain("\x1b[38;2;170;55;66mANSI_DIR\x1b[0m");
    expect(raw).toContain("hardware_id.sh");
    server.input.splice(0);
    await page
      .locator(".view:not([hidden]) .xterm-helper-textarea")
      .fill("file_color_input");
    await expect.poll(() => server.input.join("")).toBe("file_color_input");
    expect(errors).toEqual([]);
  } finally {
    await closeCleanly(app);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
