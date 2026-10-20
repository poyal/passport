import { test, expect } from "@playwright/test";
import { randomUUID as id } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reusableApp } from "../fixtures/reusable-app";
import { hostSchema, type Pane, type Workspace } from "../../src/shared/model";
import { LOCAL_HOST_ID } from "../../src/shared/advanced";
import { cloneWorkspaces } from "../../src/shared/workspace-templates";

const suite = reusableApp({ name: "workspace-identity" });
const local = (): Pane => ({
  kind: "pane",
  id: id(),
  hostId: LOCAL_HOST_ID,
  local: {
    shell: process.platform === "win32" ? "passport-bash" : "zsh",
    cwd: "",
  },
});
const split = (
  children: [Workspace["root"], Workspace["root"]],
): Workspace["root"] => ({
  kind: "split",
  id: id(),
  direction: "horizontal",
  ratio: 0.5,
  children,
});

test("AI tab icons follow live runs while manual choices templates and window moves preserve identity", async () => {
  const { page, application, directory } = suite;
  const bin = path.join(directory, "identity-bin");
  await fs.mkdir(bin);
  const script = path.join(bin, "agent.cjs");
  await fs.writeFile(
    script,
    `
const net = require('node:net');
if (process.argv.includes('--version')) { console.log('identity fixture'); process.exit(0); }
const agent = process.argv[2];
console.log('IDENTITY_READY_' + agent);
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  if (data.includes('exit')) process.exit(0);
  if (data.includes('complete')) {
    const socket = net.createConnection(process.env.PASSPORT_ENDPOINT, () =>
      socket.end(JSON.stringify({
        token: process.env.PASSPORT_TOKEN,
        generation: process.env.PASSPORT_GENERATION,
        agentRun: process.env.PASSPORT_AGENT_RUN,
        source: agent, event: 'completed'
      }) + '\\n'));
    socket.on('error', error => { throw error; });
    socket.on('close', () => console.log('IDENTITY_WAITING'));
    socket.resume();
  }
});
`,
  );
  const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
  for (const agent of ["codex", "claude"])
    await fs.writeFile(
      path.join(bin, agent + (process.platform === "win32" ? ".cmd" : "")),
      process.platform === "win32"
        ? `@"${process.execPath}" "${script}" ${agent} %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${agent} "$@"\n`,
      { mode: 0o755 },
    );
  const pane = local();
  const workspace: Workspace = { id: id(), name: "AI 아이콘", root: pane };
  await page.evaluate(
    async ({ workspace, bin }) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.settings.sessionResume = false;
      boot.document.settings.notifications.codex = false;
      boot.document.settings.notifications.claude = false;
      boot.document.settings.notifications.desktop = "off";
      boot.document.settings.terminal.profiles.push({
        id: "identity-path",
        name: "Identity fixture",
        revision: 1,
        origin: "user",
        platforms: ["darwin", "win32"],
        shells: ["zsh", "passport-bash"],
        entries: [{ kind: "path", value: bin, position: "prepend" }],
      });
      boot.document.settings.terminal.profileIds = ["identity-path"];
      boot.document.workspaces = [workspace];
      await window.passport.call("save", boot.document);
    },
    { workspace, bin },
  );
  const tab = page.locator(".workspace-tab");
  const input = (data: string) =>
    page.evaluate(
      ({ id, data }) => window.passport.call("session.input", { id, data }),
      { id: pane.id, data },
    );
  for (const agent of ["codex", "claude"] as const) {
    await page.evaluate(
      async ({ pane, agent }) => {
        const boot = await window.passport.call("bootstrap", undefined);
        boot.document.workspaces[0].root = {
          ...pane,
          local: { ...pane.local!, agent },
        };
        boot.document.workspaces[0].icon = undefined;
        await window.passport.call("save", boot.document);
        await window.passport.call("session.connect", {
          id: pane.id,
          hostId: pane.hostId,
        });
      },
      { pane, agent },
    );
    await tab.locator(".workspace-select").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      `IDENTITY_READY_${agent}`,
    );
    await expect(tab.locator(`.local-icon.${agent}`)).toBeVisible();
    await input("complete\r");
    await expect(page.locator(".xterm-rows")).toContainText("IDENTITY_WAITING");
    await expect(tab.locator(`.local-icon.${agent}`)).toBeVisible();
    await page.reload();
    // Renderer navigation deliberately releases connections in Passport.
    await expect(tab.locator(".local-icon")).toHaveCount(0);
    await page.evaluate(
      (pane) =>
        window.passport.call("session.connect", {
          id: pane.id,
          hostId: pane.hostId,
        }),
      pane,
    );
    await expect(tab.locator(`.local-icon.${agent}`)).toBeVisible();
    await page.getByRole("button", { name: "탭 설정", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "작업 탭 편집" });
    await expect(
      editor.getByLabel("탭 미리보기").locator(`.local-icon.${agent}`),
    ).toBeVisible();
    await editor
      .getByRole("button", { name: "터미널 아이콘", exact: true })
      .click();
    await editor.getByRole("button", { name: "적용", exact: true }).click();
    await expect(tab.locator(".local-icon")).toHaveCount(0);
    await page.getByRole("button", { name: "탭 설정", exact: true }).click();
    await editor
      .getByRole("button", { name: "자동 · 첫 번째 패널", exact: true })
      .click();
    await editor.getByLabel("작업 탭 이름").fill("이름을 바꾼 AI");
    await editor.getByRole("button", { name: "적용", exact: true }).click();
    await expect(tab.locator(`.local-icon.${agent}`)).toBeVisible();
    await page.evaluate(async (extra) => {
      const boot = await window.passport.call("bootstrap", undefined);
      const workspace = boot.document.workspaces[0];
      workspace.color = "#14b8a6";
      workspace.root = {
        kind: "split",
        id: crypto.randomUUID(),
        direction: "horizontal",
        ratio: 0.5,
        children: [workspace.root, extra],
      };
      await window.passport.call("save", boot.document);
    }, local());
    await expect(tab.locator(".local-icon")).toHaveCount(0);
    await page.evaluate(async () => {
      const boot = await window.passport.call("bootstrap", undefined);
      const workspace = boot.document.workspaces[0];
      if (workspace.root.kind === "split")
        workspace.root = workspace.root.children[0];
      await window.passport.call("save", boot.document);
    });
    await expect(tab.locator(`.local-icon.${agent}`)).toBeVisible();
    await page.getByRole("button", { name: "템플릿", exact: true }).click();
    await page.getByRole("button", { name: "탭 저장", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill(`저장 ${agent}`);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(
      page.locator(".workspace-template-row .local-icon"),
    ).toHaveCount(0);
    const boot = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    expect(
      boot.document.workspaceTemplates.every((t) => !t.workspaces[0].icon),
    ).toBe(true);
    expect(boot.sessionStates.find((s) => s.id === pane.id)?.activeAgent).toBe(
      agent,
    );
    expect(
      await page.evaluate(() =>
        window.passport.call("activity.list", undefined),
      ),
    ).toEqual([]);
    const nextWindow = application.waitForEvent("window");
    await page.evaluate(
      (workspaceId) => window.passport.call("window.move", { workspaceId }),
      workspace.id,
    );
    const target = await nextWindow;
    await expect(
      target.locator(`.workspace-tab .local-icon.${agent}`),
    ).toBeVisible();
    await target.evaluate(
      ({ workspaceId, target }) =>
        window.passport.call("window.move", { workspaceId, target }),
      { workspaceId: workspace.id, target: boot.windowId },
    );
    await expect(tab.locator(`.local-icon.${agent}`)).toBeVisible();
    await target.close();
    if (agent === "codex") {
      await input("exit\r");
      await expect(tab.locator(".local-icon")).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(() =>
                window.passport.call("bootstrap", undefined),
              )
            ).sessionStates.find((s) => s.id === pane.id)?.status,
        )
        .toBe("connected");
    }
    await page.evaluate(
      (id) => window.passport.call("session.close", { id }),
      pane.id,
    );
    await expect(tab.locator(".local-icon")).toHaveCount(0);
  }
});

test("template cards combine saved marks layout previews and accurate wrapping composition tags", async () => {
  const { page, application } = suite;
  const hosts = ["VTM", "TI"].map((name) =>
    hostSchema.parse({
      id: id(),
      name,
      address: "localhost",
      username: "tester",
    }),
  );
  const remote = (hostId: string): Pane => ({ kind: "pane", id: id(), hostId });
  const workspaces: Workspace[] = [
    {
      id: id(),
      name: "Agent Build",
      color: "#14b8a6",
      icon: { kind: "local", local: "codex" },
      root: split([
        remote(hosts[0].id),
        split([remote(hosts[0].id), remote(hosts[1].id)]),
      ]),
    },
    {
      id: id(),
      name: "개발 [VTM, TI]",
      color: "#d6a755",
      icon: { kind: "local", local: "package" },
      root: split([remote(hosts[0].id), remote(hosts[1].id)]),
    },
    {
      id: id(),
      name: "혼합 작업 · 긴 이름에서도 구성 태그가 카드 안에서 자연스럽게 이어집니다",
      icon: { kind: "emoji", value: "🛠️" },
      root: split([split([remote(hosts[0].id), remote(hosts[0].id)]), local()]),
    },
    { id: id(), name: "로컬 전용", root: local() },
  ];
  const templates = workspaces.map((workspace) => ({
    id: id(),
    name: workspace.name,
    ...cloneWorkspaces([workspace], workspace.id, "", id),
  }));
  await page.evaluate(
    async ({ hosts, templates }) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.hosts = hosts;
      boot.document.workspaceTemplates = templates;
      await window.passport.call("save", boot.document);
    },
    { hosts, templates },
  );
  await page.getByRole("button", { name: "템플릿", exact: true }).click();
  const cards = page.locator(".workspace-template-row");
  await expect(cards.nth(0).locator(".template-tag")).toHaveText([
    "SSH 3",
    "호스트 2",
  ]);
  await expect(cards.nth(0).locator(".local-icon.codex")).toBeVisible();
  await expect(cards.nth(0).locator(".workspace-extra")).toHaveText("+2");
  await expect(cards.nth(1).locator(".local-icon.package")).toBeVisible();
  await expect(cards.nth(1).locator(".template-preview-pane")).toHaveCount(2);
  await expect(cards.nth(2).locator(".template-tag")).toHaveText([
    "SSH 2",
    "호스트 1",
    "로컬 1",
  ]);
  await expect(cards.nth(2).locator(".workspace-emoji")).toHaveText("🛠️");
  await expect(cards.nth(3).locator(".template-tag")).toHaveText(["로컬 1"]);
  await expect(cards.nth(3).locator(".workspace-extra")).toHaveCount(0);
  for (const mode of ["dark", "light"] as const) {
    await page.evaluate(async (mode) => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.settings.colorMode = mode;
      await window.passport.call("save", boot.document);
    }, mode);
    for (const width of [1100, 1024]) {
      await application.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setContentSize(width, 760),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await expect
        .poll(() =>
          cards.evaluateAll((elements) =>
            elements.every((el) => el.scrollWidth <= el.clientWidth),
          ),
        )
        .toBe(true);
      for (const tag of await page.locator(".template-tag").all()) {
        const box = await tag.boundingBox();
        const card = await tag.locator("xpath=ancestor::section").boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width);
      }
      await page.screenshot({
        path: test.info().outputPath(`templates-${mode}-${width}.png`),
      });
    }
  }
  await page.reload();
  await page.getByRole("button", { name: "템플릿", exact: true }).click();
  await expect(cards.nth(1).locator(".local-icon.package")).toBeVisible();
  await page
    .getByRole("button", { name: "개발 [VTM, TI] 배치만 열기", exact: true })
    .click();
  await expect(
    page.locator(".workspace-tab .local-icon.package"),
  ).toBeVisible();
  const boot = await page.evaluate(() =>
    window.passport.call("bootstrap", undefined),
  );
  expect(boot.document.workspaces[0].color).toBe("#d6a755");
  expect(boot.sessionStates).toEqual([]);
});
