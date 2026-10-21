import { test, expect } from "@playwright/test";
import { randomUUID as id } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reusableApp } from "../fixtures/reusable-app";
import { sshFixture } from "../fixtures/ssh-server";
import {
  hostSchema,
  groupSchema,
  type Pane,
  type Workspace,
} from "../../src/shared/model";
import { LOCAL_HOST_ID } from "../../src/shared/advanced";
import { defaultTerminalSettings } from "../../src/shared/terminal-config";

const suite = reusableApp({ name: "workspace-management" });
const local = (): Pane => ({
  kind: "pane",
  id: id(),
  hostId: LOCAL_HOST_ID,
  local: { shell: defaultTerminalSettings(process.platform).shell, cwd: "" },
});
const document = () =>
  suite.page.evaluate(
    async () => (await window.passport.call("bootstrap", undefined)).document,
  );

test("workspace icon tiles emoji presets colors and extra panel counts survive editing and renderer reload", async () => {
  const { page, application } = suite;
  const host = hostSchema.parse({
    id: id(),
    name: "Ubuntu primary",
    address: "localhost",
    username: "tester",
  });
  const workspace: Workspace = {
    id: id(),
    name: "운영 서버",
    root: {
      kind: "split",
      id: id(),
      direction: "horizontal",
      ratio: 0.5,
      children: [{ kind: "pane", id: id(), hostId: host.id }, local()],
    },
  };
  await page.evaluate(
    async ({ host, workspace }) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.hosts = [host];
      boot.document.workspaces = [workspace];
      await window.passport.call("save", boot.document);
    },
    { host, workspace },
  );
  const tab = page.locator(".workspace-tab");
  await expect(tab.locator(".host-icon")).toHaveClass(/ubuntu/);
  await expect(tab.locator(".workspace-extra")).toHaveText("+1");
  await tab.locator(".workspace-select").dblclick();
  const editor = page.getByRole("dialog", { name: "작업 탭 편집" });
  await expect(editor).toHaveCount(0);
  await expect(tab).toHaveAttribute("draggable", "true");
  await expect(tab.locator(".workspace-drag")).toHaveCount(0);
  await page
    .locator(".view:not([hidden])")
    .getByRole("button", { name: "탭 설정", exact: true })
    .click();
  await expect(editor).toHaveCount(1);
  await expect(editor.locator("select")).toHaveCount(0);
  await expect(
    editor
      .getByRole("group", { name: "운영체제 아이콘", exact: true })
      .getByRole("button"),
  ).toHaveCount(12);
  const debian = editor.getByRole("button", {
    name: "Debian 아이콘",
    exact: true,
  });
  await debian.focus();
  await page.keyboard.press("Space");
  await expect(debian).toHaveAttribute("aria-pressed", "true");
  await expect(
    editor.getByLabel("탭 미리보기").locator(".host-icon"),
  ).toHaveClass(/debian/);
  await page.screenshot({
    path: test.info().outputPath("workspace-icon-tiles.png"),
  });
  await page
    .getByLabel("작업 탭 이름", { exact: true })
    .fill("운영 서버의 긴 이름 · 확인과 배포");
  await editor.getByRole("button", { name: "이모지", exact: true }).click();
  await expect(editor.getByRole("button", { name: /^이모지 / })).toHaveCount(
    48,
  );
  const container = editor.getByRole("button", {
    name: "이모지 🐳 · 컨테이너",
    exact: true,
  });
  await container.click();
  await expect(container).toHaveAttribute("aria-pressed", "true");
  await expect(
    editor.getByLabel("탭 미리보기").locator(".workspace-emoji"),
  ).toHaveText("🐳");
  await page.getByLabel("탭 이모지", { exact: true }).fill("🚀🚀");
  await editor.getByRole("button", { name: "적용", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText(
    "이모지를 한 개 입력해 주세요.",
  );
  await page.getByLabel("탭 이모지", { exact: true }).fill("👩🏽‍💻");
  await page.getByLabel("탭 색상 HEX", { exact: true }).fill("#EC4899");
  await editor.getByRole("button", { name: "적용", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(tab.locator(".workspace-emoji")).toHaveText("👩🏽‍💻");
  expect((await document()).workspaces[0]).toMatchObject({
    color: "#ec4899",
    icon: { kind: "emoji", value: "👩🏽‍💻" },
  });
  const toolbar = page.locator(".view:not([hidden]) .workspace-bar");
  await expect(toolbar).toHaveClass(/colored/);
  expect(
    await toolbar.evaluate((el) => el.style.getPropertyValue("--tab-color")),
  ).toBe("#ec4899");
  const recovery = toolbar.getByRole("button", {
    name: "끊긴 연결 복구 · 2",
    exact: true,
  });
  await expect(recovery).toHaveText("");
  await expect(recovery.locator("svg")).toHaveCount(1);
  await toolbar.screenshot({
    path: test.info().outputPath("workspace-recovery-toolbar.png"),
  });
  await page.reload();
  await expect(tab.locator(".workspace-emoji")).toHaveText("👩🏽‍💻");
  await page
    .getByRole("button", { name: "작업 목록 접기", exact: true })
    .click();
  await expect(tab.locator(".workspace-extra")).toBeVisible();
  await expect(tab.locator(".workspace-drag")).toHaveCount(0);
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(async (mode) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.settings.colorMode = mode;
      await window.passport.call("save", boot.document);
    }, mode);
    const [outer, mark, badge] = await Promise.all([
      tab.boundingBox(),
      tab.locator(".workspace-mark").boundingBox(),
      tab.locator(".workspace-extra").boundingBox(),
    ]);
    expect(mark!.x).toBeGreaterThanOrEqual(outer!.x);
    expect(badge!.x + badge!.width).toBeLessThanOrEqual(
      outer!.x + outer!.width + 1,
    );
    const colors = await toolbar.evaluate((el) => ({
      tint: getComputedStyle(el).backgroundColor,
      base: getComputedStyle(globalThis.document.body).backgroundColor,
    }));
    expect(colors.tint).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.tint).not.toBe(colors.base);
  }
  await tab.locator(".workspace-select").dblclick();
  await expect(editor).toHaveCount(0);
  await tab.locator(".workspace-select").click({ button: "right" });
  await page.getByRole("menuitem", { name: "탭 편집", exact: true }).click();
  await expect(editor).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
  );
  const [dialogBox, applyBox] = await Promise.all([
    editor.boundingBox(),
    editor.getByRole("button", { name: "적용", exact: true }).boundingBox(),
  ]);
  expect(applyBox!.y + applyBox!.height).toBeLessThan(
    dialogBox!.y + dialogBox!.height,
  );
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(
    await page.evaluate(() => innerHeight),
  );
  await page.screenshot({
    path: test.info().outputPath("workspace-emoji-presets.png"),
  });
  await editor.getByRole("button", { name: "취소", exact: true }).click();
  await tab.locator(".workspace-select").click({ button: "right" });
  await page.getByRole("menuitem", { name: "탭 편집", exact: true }).click();
  await editor
    .getByRole("button", { name: "자동 · 첫 번째 패널", exact: true })
    .click();
  await editor.getByRole("button", { name: "기본 색상", exact: true }).click();
  await editor.getByRole("button", { name: "적용", exact: true }).click();
  await expect(tab.locator(".host-icon")).toHaveClass(/ubuntu/);
  expect((await document()).workspaces[0].color).toBeUndefined();
  await expect(toolbar).not.toHaveClass(/colored/);
  expect(
    await toolbar.evaluate((el) => el.style.getPropertyValue("--tab-color")),
  ).toBe("");
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 760),
  );
  await expect(tab.locator(".workspace-extra")).toBeVisible();
});

test("global project defaults start new local tabs without changing an existing session", async () => {
  const { page, directory } = suite;
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  const before = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  const first = before.sessionStates[0];
  await expect(
    page.getByRole("button", { name: "프로젝트 설정", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "로컬 터미널", exact: true })
    .click();
  const folder = path.join(directory, "global project");
  await fs.mkdir(folder);
  await page.getByLabel("기본 프로젝트 폴더", { exact: true }).fill(folder);
  await page.getByLabel("기본 프로젝트 폴더", { exact: true }).press("Tab");
  await expect
    .poll(async () => (await document()).settings.terminal.cwd)
    .toBe(folder);
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  const after = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  const created = after.sessionStates.find((s) => s.id !== first.id)!;
  expect(created.environment?.cwd).toBe(folder);
  expect(
    after.sessionStates.find((s) => s.id === first.id)?.environment
      ?.sessionInstanceId,
  ).toBe(first.environment?.sessionInstanceId);
  expect(after.document.workspaces.every((w) => !("project" in w))).toBe(true);
  await expect(
    page.getByRole("button", { name: "탭 설정", exact: true }),
  ).toBeVisible();
  await page.reload();
  expect((await document()).settings.terminal.cwd).toBe(folder);
});

test("host group sections restore collapse after search and remove empty unassigned sections", async () => {
  const { page } = suite;
  const group = groupSchema.parse({ id: id(), name: "운영", parentId: null });
  const child = groupSchema.parse({ id: id(), name: "웹", parentId: group.id });
  const hosts = [null, group.id, child.id].map((groupId, i) =>
    hostSchema.parse({
      id: id(),
      name: `서버 ${i}`,
      address: "localhost",
      username: "tester",
      groupId,
    }),
  );
  await page.evaluate(
    async ({ hosts, groups }) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.hosts = hosts;
      boot.document.groups = groups;
      await window.passport.call("save", boot.document);
    },
    { hosts, groups: [group, child] },
  );
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  const unassigned = page.locator(".host-group").filter({
    has: page.getByRole("button", { name: "미지정 1", exact: true }),
  });
  await expect(page.locator(".host-group-heading")).toHaveText([
    "운영1",
    "운영 / 웹1",
    "미지정1",
  ]);
  await unassigned.locator(".host-group-heading").click();
  await expect(unassigned.locator(".host-row")).toBeHidden();
  await page.getByLabel("호스트 검색").fill("서버 0");
  await expect(unassigned.locator(".host-row")).toBeVisible();
  await page.getByLabel("호스트 검색").fill("");
  await expect(unassigned.locator(".host-row")).toBeHidden();
  await page.getByLabel("현재 목록 전체 선택", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "일괄 편집 · 3", exact: true }),
  ).toBeEnabled();
  await page.evaluate(
    async ({ hostId, groupId }) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.hosts = boot.document.hosts.map((h) =>
        h.id === hostId ? { ...h, groupId } : h,
      );
      await window.passport.call("save", boot.document);
    },
    { hostId: hosts[0].id, groupId: group.id },
  );
  await expect(unassigned).toHaveCount(0);
  await expect(page.locator(".host-group-heading")).toHaveText([
    "운영2",
    "운영 / 웹1",
  ]);
});

test("workspace recovery leaves healthy local sessions intact and reopens only disconnected panes", async () => {
  const { page } = suite;
  const first = local(),
    second = local();
  const workspace: Workspace = {
    id: id(),
    name: "복구 검사",
    root: {
      kind: "split",
      id: id(),
      direction: "horizontal",
      ratio: 0.5,
      children: [first, second],
    },
  };
  await page.evaluate(async (workspace) => {
    const boot = await window.passport.call("bootstrap", undefined);
    boot.document.workspaces = [workspace];
    await window.passport.call("save", boot.document);
  }, workspace);
  await page.getByRole("button", { name: "복구 검사", exact: true }).click();
  await page.evaluate(
    async (id) =>
      window.passport.call("session.connect", {
        id,
        hostId: "00000000-0000-4000-8000-000000000001",
      }),
    first.id,
  );
  const generation = async (id: string) =>
    page.evaluate(
      async (id) =>
        (await window.passport.call("bootstrap", undefined)).sessionStates.find(
          (s) => s.id === id,
        )?.environment?.sessionInstanceId,
      id,
    );
  const healthy = await generation(first.id);
  await page
    .getByRole("button", { name: "끊긴 연결 복구 · 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /끊긴 연결 복구|연결 복구 중/ }),
  ).toHaveCount(0);
  expect(await generation(first.id)).toBe(healthy);
  const reopened = await generation(second.id);
  await page.evaluate(async (id) => {
    await window.passport.call("session.connect", {
      id,
      hostId: "00000000-0000-4000-8000-000000000001",
      onlyIfDisconnected: true,
    });
  }, first.id);
  expect(await generation(first.id)).toBe(healthy);
  await page.evaluate(
    async (id) => window.passport.call("session.close", { id }),
    second.id,
  );
  await page
    .getByRole("button", { name: "끊긴 연결 복구 · 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /끊긴 연결 복구|연결 복구 중/ }),
  ).toHaveCount(0);
  expect(await generation(second.id)).not.toBe(reopened);
  expect(await generation(first.id)).toBe(healthy);
});

test("workspace recovery continues after cancelled and failed authentication with one prompt at a time", async () => {
  const { page, application, directory } = suite;
  const root = path.join(directory, "recovery-remote");
  await fs.mkdir(root);
  const server = await sshFixture(root);
  const hosts = ["취소", "실패", "성공 A", "성공 B"].map((name) =>
    hostSchema.parse({
      id: id(),
      name,
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
    }),
  );
  const remotes: Pane[] = hosts.map((host) => ({
    kind: "pane",
    id: id(),
    hostId: host.id,
  }));
  const first = local(),
    other = local();
  const workspace: Workspace = {
    id: id(),
    name: "부분 복구",
    root: remotes.reduce<Workspace["root"]>(
      (root, pane) => ({
        kind: "split",
        id: id(),
        direction: "vertical",
        ratio: 0.5,
        children: [root, pane],
      }),
      first,
    ),
  };
  try {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await page.evaluate(
      async ({ hosts, workspace, other }) => {
        const boot = await window.passport.call("bootstrap", undefined);
        boot.document.hosts = hosts;
        boot.document.workspaces = [
          workspace,
          { id: crypto.randomUUID(), name: "다른 탭", root: other },
        ];
        await window.passport.call("save", boot.document);
      },
      { hosts, workspace, other },
    );
    await page.getByRole("button", { name: "부분 복구", exact: true }).click();
    await page
      .getByRole("button", { name: "끊긴 연결 복구 · 5", exact: true })
      .click();
    const progress = page.getByRole("button", {
      name: "연결 복구 중",
      exact: true,
    });
    await expect(progress).toBeDisabled();
    for (const [i, host] of hosts.entries()) {
      const prompt = page.getByRole("dialog", {
        name: `${host.name} 인증`,
        exact: true,
      });
      await expect(prompt).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      if (i === 0)
        await prompt.getByRole("button", { name: "취소", exact: true }).click();
      else {
        await prompt
          .getByLabel("비밀번호", { exact: true })
          .fill(i === 1 ? "incorrect" : "test-only-password");
        await prompt.getByRole("button", { name: "연결", exact: true }).click();
      }
    }
    await expect(
      page.getByRole("button", { name: "끊긴 연결 복구 · 2", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "3 / 5 연결",
    );
    const states = await page.evaluate(
      async () =>
        (await window.passport.call("bootstrap", undefined)).sessionStates,
    );
    expect(states.find((s) => s.id === remotes[0].id)).toBeUndefined();
    expect(states.find((s) => s.id === remotes[1].id)?.status).toBe("error");
    expect(states.find((s) => s.id === other.id)).toBeUndefined();
    expect(server.shells).toHaveLength(2);
  } finally {
    for (const pane of [first, ...remotes])
      await page.evaluate(
        async (id) => window.passport.call("session.close", { id }),
        pane.id,
      );
    await server.close();
  }
});

test("macOS local OpenSSH accepts multiline paste with and without bracketed paste", async () => {
  test.skip(process.platform !== "darwin", "Requires macOS local OpenSSH.");
  const { page, application, directory } = suite;
  const root = path.join(directory, "ssh-root");
  await fs.mkdir(root);
  const server = await sshFixture(root, undefined, { bracketedPaste: false });
  let pane = "";
  try {
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "1 / 1 연결",
    );
    pane = (await page
      .locator(".view:not([hidden]) .terminal-pane")
      .getAttribute("data-pane-id"))!;
    const rows = page.locator(".view:not([hidden]) .xterm-rows");
    await expect(rows).toContainText(/[%$#❯]/);
    await page.evaluate(
      async ({ pane, port }) =>
        window.passport.call("session.input", {
          id: pane,
          data: `ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -p ${port} tester@127.0.0.1\r`,
        }),
      { pane, port: server.port },
    );
    await expect(rows).toContainText(/password:/i);
    await page.evaluate(
      async (id) =>
        window.passport.call("session.input", {
          id,
          data: "test-only-password\r",
        }),
      pane,
    );
    await expect(rows).toContainText("테스트 서버에 연결되었습니다.");
    await application.evaluate(({ clipboard }) => {
      clipboard.read = async () =>
        [
          {
            types: ["text/plain"],
            getType: async (_type: string) =>
              new Blob(["printf FIRST\r\nprintf SECOND\n"]),
          },
        ] as Electron.ClipboardItem[];
    });
    const area = page.locator(".view:not([hidden]) .xterm-helper-textarea");
    server.input.splice(0);
    await area.focus();
    await page.keyboard.press("Meta+v");
    await expect
      .poll(() => server.input.join(""))
      .toBe("printf FIRST\rprintf SECOND");
    server.input.splice(0);
    server.shells[0].write("\x1b[?2004h\r\nBRACKETED_READY\r\n");
    await expect(rows).toContainText("BRACKETED_READY");
    await area.focus();
    await page.keyboard.press("Meta+v");
    await expect
      .poll(() => server.input.join(""))
      .toBe("\x1b[200~printf FIRST\rprintf SECOND\x1b[201~");
    await expect(page.locator(".toast.error")).toHaveCount(0);
  } finally {
    if (pane)
      await page.evaluate(
        async (id) => window.passport.call("session.close", { id }),
        pane,
      );
    await server.close();
  }
});
