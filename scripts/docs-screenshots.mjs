// Run after npm run build. All connections and data belong to this demo run.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { emptyDocument, hostSchema } from "../src/shared/model.ts";
import { sshFixture } from "../tests/fixtures/ssh-server.ts";
import { closeCleanly } from "../tests/fixtures/electron-exit.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "docs/assets");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-docs-"));
let server, app;
try {
  const remote = path.join(directory, "remote");
  for (const folder of [
    "releases",
    "archive",
    "releases/config",
    "releases/logs",
    "archive/previous",
  ])
    await fs.mkdir(path.join(remote, folder), { recursive: true });
  const samples = {
    "releases/release-notes.md":
      "# Passport demo\n\n문서 촬영용 예제 파일입니다.\n",
    "releases/app-config.json": '{"environment":"demo","port":8080}\n',
    "releases/deploy.sh": '#!/bin/sh\nprintf "Demo deployment\\n"\n',
    "releases/health-check.txt": "api: ready\nworker: ready\nweb: ready\n",
    "releases/시작하기.txt": "Passport 예제 작업 공간\n",
    "archive/README.md": "# Archive\n문서 촬영용 보관 폴더\n",
    "archive/checksums.txt": "Demo files only\n",
  };
  for (const [name, content] of Object.entries(samples)) {
    await fs.writeFile(path.join(remote, name), content);
    await fs.utimes(
      path.join(remote, name),
      new Date("2026-09-29T00:00:00Z"),
      new Date("2026-09-29T00:00:00Z"),
    );
  }
  server = await sshFixture(remote);
  app = await electron.launch({
    args: [root],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "profile") },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, dialog, safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (text) => Buffer.from(text);
    safeStorage.decryptString = (buffer) => buffer.toString();
    // The only SSH endpoint used here is our disposable loopback fixture.
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
    BrowserWindow.getAllWindows()[0].setContentSize(1360, 850);
  });
  page.setDefaultTimeout(15000);
  await page.waitForSelector(".hosts-view");
  const { version } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  expect(
    await page.evaluate(async () => {
      const boot = await window.passport.call("bootstrap", undefined);
      return boot.appVersion;
    }),
  ).toBe(version);
  const groups = ["개발", "스테이징", "프로덕션"].map((name) => ({
    id: randomUUID(),
    name,
    parentId: null,
    defaults: {},
  }));
  const names = [
    "개발 · API",
    "개발 · Worker",
    "스테이징 · Web",
    "스테이징 · DB",
    "프로덕션 · API",
    "프로덕션 · Web",
  ];
  const hosts = names.map((name, i) =>
    hostSchema.parse({
      id: randomUUID(),
      name,
      address: i < 3 ? "127.0.0.1" : `192.0.2.${10 + i}`,
      port: i < 3 ? server.port : 22,
      username: "tester",
      groupId: groups[Math.floor(i / 2)].id,
      tags:
        i < 2
          ? ["개발", i === 0 ? "API" : "배치"]
          : i < 4
            ? ["검증"]
            : ["운영"],
      favorite: i === 0 || i === 4,
      icon: ["alpine", "centos", "redhat", "rocky", "ubuntu", "windows"][i],
      iconPinned: true,
      startPath: i === 1 ? "/archive" : "/releases",
      appearance: { theme: ["mocha", "nord", "tokyo-night"][i % 3] },
    }),
  );
  const panes = hosts
    .slice(0, 3)
    .map((host) => ({ kind: "pane", id: randomUUID(), hostId: host.id }));
  const document = emptyDocument();
  document.hosts = hosts;
  document.groups = groups;
  document.settings.colorMode = "dark";
  document.settings.appearance.fontSize = 14;
  document.snippets = [
    {
      id: randomUUID(),
      name: "서비스 상태 확인",
      group: "운영",
      description: "서비스의 현재 상태를 확인합니다.",
      content: "systemctl status {{service}}",
    },
    {
      id: randomUUID(),
      name: "최근 로그 보기",
      group: "운영",
      description: "최근 50줄을 확인합니다.",
      content: "tail -n 50 /var/log/app.log",
    },
  ];
  document.workspaces = [
    {
      id: randomUUID(),
      name: "서비스 모니터링",
      root: {
        kind: "split",
        id: randomUUID(),
        direction: "horizontal",
        ratio: 0.56,
        children: [
          panes[0],
          {
            kind: "split",
            id: randomUUID(),
            direction: "vertical",
            ratio: 0.5,
            children: [panes[1], panes[2]],
          },
        ],
      },
    },
  ];
  const profileId = randomUUID();
  document.hosts.forEach((host) => {
    host.authId = profileId;
  });
  await page.evaluate(
    async ({ document, profileId }) => {
      await window.passport.call("auth.save", {
        id: profileId,
        name: "개발 공통 인증",
        username: "tester",
        secret: {
          type: "password",
          password: "test-only-password",
          privateKey: "",
          passphrase: "",
        },
      });
      const current = await window.passport.call("bootstrap", undefined);
      await window.passport.call("save", {
        ...document,
        revision: current.document.revision,
      });
    },
    { document, profileId },
  );
  await page.reload();
  await page.locator(".workspace-tab>button").first().click();
  // Sequential connection preserves the pane-to-fixture-channel order.
  for (const pane of panes) {
    await page.evaluate(
      async (pane) =>
        window.passport.call("session.connect", {
          id: pane.id,
          hostId: pane.hostId,
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        }),
      pane,
    );
  }
  await expect.poll(() => server.shells.length).toBe(3);
  const mint = (text) => `\x1b[32m${text}\x1b[0m`;
  const blue = (text) => `\x1b[36m${text}\x1b[0m`;
  const muted = (text) => `\x1b[90m${text}\x1b[0m`;
  const lines = [
    [
      blue("PASSPORT / DEVELOPMENT"),
      muted("문서 촬영용 SSH 예제 세션"),
      "",
      "$ tail -f /var/log/api.log",
      "",
      `${muted("09:41:01")} ${mint("INFO")}  API server listening on :8080`,
      `${muted("09:41:02")} ${mint("INFO")}  Database connection ready`,
      `${muted("09:41:03")} ${mint("INFO")}  GET /health          200   2ms`,
      `${muted("09:41:04")} ${mint("INFO")}  GET /api/projects    200  14ms`,
      `${muted("09:41:05")} ${mint("INFO")}  GET /api/hosts       200   8ms`,
      `${muted("09:41:06")} \x1b[33mWARN\x1b[0m  Cache miss · rebuilding index`,
      `${muted("09:41:07")} ${mint("INFO")}  Index rebuilt        128 entries`,
      `${muted("09:41:08")} ${mint("INFO")}  GET /api/projects    200   3ms`,
      "",
      mint("● 예제 서비스가 정상 응답하고 있습니다."),
      "",
      muted("SSH · UTF-8 · 256 colors"),
      "",
    ],
    [
      blue("WORKER / RELEASE FILES"),
      "$ ls -l",
      "drwxr-xr-x 2 me me 4096 Sep 30 09:41 config",
      "drwxr-xr-x 2 me me 4096 Sep 30 09:41 logs",
      "-rwxr-xr-x 1 me me  128 Sep 30 09:41 deploy.sh",
      "-rw-r--r-- 1 me me  256 Sep 30 09:41 app-config.json",
      "lrwxrwxrwx 1 me me    7 Sep 30 09:41 current -> releases",
      "",
      "tester@worker:~/releases$ ",
    ],
    [
      blue("STAGING / WEB"),
      "",
      "$ curl -I https://web.example.test",
      "",
      mint("HTTP/2 200"),
      "content-type: text/html; charset=utf-8",
      "cache-control: no-cache",
      "",
      "tester@web:~$ ",
    ],
  ];
  server.shells.forEach((shell, i) =>
    shell.write("\x1b[2J\x1b[H" + lines[i].join("\r\n")),
  );
  await expect(page.locator(".view:not([hidden]) .terminal-pane")).toHaveCount(
    3,
  );
  await expect
    .poll(() => page.locator(".xterm-rows").allTextContents())
    .toContainEqual(expect.stringContaining("예제 서비스"));
  await fs.mkdir(output, { recursive: true });
  const capture = async (name) => {
    await page.mouse.move(1, 1);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: path.join(output, name),
      animations: "disabled",
    });
    console.log(`Captured docs/assets/${name}`);
  };
  await capture("workspace.png");
  await page.getByRole("button", { name: "외형", exact: true }).click();
  await expect(page.locator(".toolbox .theme-item")).toHaveCount(12);
  await page
    .locator(".toolbox .theme-item")
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await capture("appearance.png");
  await page
    .getByRole("button", { name: "도구 패널 닫기", exact: true })
    .click();
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await page.locator(".host-row").filter({ hasText: "개발 · API" }).click();
  await page
    .getByRole("heading", { name: "호스트 설정", exact: true })
    .scrollIntoViewIfNeeded();
  await capture("hosts.png");
  await page.getByRole("button", { name: "파일", exact: true }).click();
  for (const [index, label] of ["왼쪽 연결", "오른쪽 연결"].entries()) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: new RegExp(hosts[index].name) })
      .click();
    await expect(
      page.getByLabel(index ? "오른쪽 경로" : "왼쪽 경로", { exact: true }),
    ).toHaveValue(index ? "/archive" : "/releases");
  }
  const left = page.getByRole("region", { name: "왼쪽 파일 패널" });
  await left.getByRole("row").filter({ hasText: "release-notes.md" }).click();
  await page
    .getByRole("button", { name: "왼쪽 → 오른쪽", exact: true })
    .click();
  await expect(page.locator(".transfer-row.completed")).toHaveCount(1);
  await left.locator(".file-table-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await left
    .getByRole("row")
    .filter({ hasText: "app-config.json" })
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await capture("files.png");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "외형", exact: true })
    .click();
  await page.getByRole("tab", { name: "테마", exact: true }).click();
  await expect(page.locator(".settings-content .theme-item")).toHaveCount(12);
  await expect(page.locator(".settings-sidebar .sidebar-foot")).toHaveText(
    `Passport ${version}`,
  );
  await capture("settings.png");
} finally {
  try {
    if (app) await closeCleanly(app);
  } finally {
    await server?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
