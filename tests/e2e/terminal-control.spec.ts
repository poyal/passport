import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reusableApp } from "../fixtures/reusable-app";
import { hostSchema } from "../../src/shared/model";

const home = path.join(os.tmpdir(), `passport-cli-home-${randomUUID()}`);
test.beforeAll(async () => {
  await fs.mkdir(home, { recursive: true });
});
const suite = reusableApp({
  name: "terminal-control",
  env: { HOME: home, USERPROFILE: home },
});
test.afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});
const bashPath = (value: string) =>
  process.platform === "win32"
    ? value
        .replace(/\\/g, "/")
        .replace(
          /^([A-Za-z]):/,
          (_, drive: string) => `/${drive.toLowerCase()}`,
        )
    : value;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const boot = (page = suite.page) =>
  page.evaluate(() => window.passport.call("bootstrap", undefined));
const input = (page: Page, id: string, data: string) =>
  page.evaluate(
    ({ id, data }) => window.passport.call("session.input", { id, data }),
    { id, data },
  );

// The coordinator is actually launched inside a Passport PTY. Its CLI children
// inherit credentials normally; tokens are never extracted into test artifacts.
async function coordinator(page: Page, paneId: string) {
  const directory = path.join(suite.directory, randomUUID());
  await fs.mkdir(directory);
  const script = path.join(directory, "coordinator.cjs");
  const request = path.join(directory, "request.json");
  const response = path.join(directory, "response.json");
  const ready = path.join(directory, "ready");
  await fs.writeFile(
    script,
    `
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const request = ${JSON.stringify(request)}, response = ${JSON.stringify(response)};
let last, busy = false;
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
setInterval(() => {
  if (busy) return;
  let job; try { job = JSON.parse(fs.readFileSync(request, 'utf8')); } catch { return; }
  if (job.id === last) return;
  last = job.id; busy = true;
  const child = execFile(process.platform === 'win32' ? 'passport.exe' : 'passport', job.args,
    { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => {
      fs.writeFileSync(response, JSON.stringify({ id: job.id, code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
      busy = false;
    });
  child.stdin.end(job.stdin || '');
}, 25);
`,
  );
  await input(
    page,
    paneId,
    `${quote(bashPath(process.execPath))} ${quote(bashPath(script))}\r`,
  );
  await expect
    .poll(() => fs.readFile(ready, "utf8").catch(() => ""))
    .toBe("ready");
  return async (args: string[], stdin?: string) => {
    const id = randomUUID();
    await fs.writeFile(
      request,
      JSON.stringify({ id, args: [...args, "--json"], stdin }),
    );
    let result:
      { id: string; code: number; stdout: string; stderr: string } | undefined;
    await expect
      .poll(
        async () => {
          try {
            result = JSON.parse(await fs.readFile(response, "utf8"));
            return result?.id;
          } catch {
            return undefined;
          }
        },
        { timeout: 10000 },
      )
      .toBe(id);
    return { code: result!.code, ...JSON.parse(result!.stdout) };
  };
}
async function setup() {
  await suite.page.evaluate(async () => {
    const b = await window.passport.call("bootstrap", undefined);
    b.document.settings.terminal.cliAccess = "write";
    b.document.settings.terminal.shell =
      b.platform === "win32" ? "passport-bash" : "bash";
    b.document.settings.terminal.profileIds = [];
    await window.passport.call("save", b.document);
  });
  await suite.page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  await expect(suite.page.locator(".xterm-rows")).toContainText(/\$\s*$/);
  const source = (await boot()).sessionStates[0].id;
  const cli = await coordinator(suite.page, source);
  const nextWindow = suite.application.waitForEvent("window");
  const windowId = await suite.page.evaluate(() =>
    window.passport.call("window.create", undefined),
  );
  const targetPage = await nextWindow;
  await targetPage.waitForSelector(".xterm-rows");
  await expect(targetPage.locator(".xterm-rows")).toContainText(/\$\s*$/);
  const targetBoot = await boot(targetPage);
  const target = targetBoot.sessionStates.find((s) => s.id !== source)!.id;
  const workspace = targetBoot.document.workspaces.find(
    (w) => w.root.kind === "pane" && w.root.id === target,
  )!;
  return {
    source,
    cli,
    targetPage,
    target,
    workspaceId: workspace.id,
    windowId,
  };
}
async function rawTarget(page: Page, paneId: string) {
  const file = path.join(suite.directory, `${randomUUID()}.txt`);
  const script = file + ".cjs";
  await fs.writeFile(
    script,
    `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(file)}, '');
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h\x1b[31mTUI_READY\x1b[0m\\r\\n');
process.stdin.on('data', data => { fs.appendFileSync(${JSON.stringify(file)}, data); });
`,
  );
  await input(
    page,
    paneId,
    `${quote(bashPath(process.execPath))} ${quote(bashPath(script))}\r`,
  );
  await expect(page.locator(".xterm-rows")).toContainText("TUI_READY");
  return file;
}

test("CLI identifies its pane and preserves literal input and alternate-screen reads across windows", async () => {
  const f = await setup();
  const identified = await f.cli(["identify"]);
  expect(identified).toMatchObject({
    code: 0,
    ok: true,
    value: { paneId: f.source },
  });
  const listed = await f.cli(["list"]);
  expect(listed.value).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ paneId: f.target, windowId: f.windowId }),
    ]),
  );
  const captured = await rawTarget(f.targetPage, f.target);
  const text = "한글 {{그대로}}\n둘\t끝\n";
  const file = path.join(suite.directory, "요청 파일.txt");
  await fs.writeFile(file, text);
  expect(
    await f.cli(["send", "--pane", f.target, "--file", file]),
  ).toMatchObject({ code: 0, ok: true });
  const pasted = "\x1b[200~한글 {{그대로}}\r둘\t끝\r\x1b[201~";
  await expect.poll(() => fs.readFile(captured, "utf8")).toBe(pasted);
  expect(await f.cli(["key", "--pane", f.target, "enter"])).toMatchObject({
    ok: true,
  });
  await expect.poll(() => fs.readFile(captured, "utf8")).toBe(pasted + "\r");
  expect(
    await f.cli(
      ["send", "--pane", f.target, "--file", "-", "--submit"],
      "표준입력\n",
    ),
  ).toMatchObject({ ok: true });
  await expect
    .poll(() => fs.readFile(captured, "utf8"))
    .toBe(pasted + "\r\x1b[200~표준입력\r\x1b[201~\r");
  const read = await f.cli(["read", "--pane", f.target, "--lines", "20"]);
  expect(read).toMatchObject({
    ok: true,
    value: { buffer: "alternate", text: "TUI_READY" },
  });
  expect(read.value.text).not.toContain("\x1b");
  expect(
    await f.cli(["send", "--pane", f.target, "bad\x1btext"]),
  ).toMatchObject({ code: 1, error: { code: "CONTROL_CHARACTER" } });
});

test("CLI reads inactive and moved panes and retains the screen after disconnect", async () => {
  const f = await setup();
  await input(f.targetPage, f.target, "printf 'SCREEN_%s\\n' RETAINED\r");
  await expect(f.targetPage.locator(".xterm-rows")).toContainText(
    "SCREEN_RETAINED",
  );
  // Activate another tab so the queried xterm has no visible mount.
  await f.targetPage
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  expect((await f.cli(["read", "--pane", f.target])).value.text).toContain(
    "SCREEN_RETAINED",
  );
  await f.targetPage.evaluate(
    async ({ workspaceId, target }) => {
      await window.passport.call("window.move", { workspaceId, target });
    },
    { workspaceId: f.workspaceId, target: (await boot()).windowId },
  );
  await expect
    .poll(async () => (await boot()).workspaceOwners[f.workspaceId])
    .toBe((await boot()).windowId);
  await expect
    .poll(async () => {
      const result = await f.cli(["read", "--pane", f.target]);
      return result.ok ? result.value.text : "";
    })
    .toContain("SCREEN_RETAINED");
  await suite.page.evaluate(
    (id) => window.passport.call("session.close", { id }),
    f.target,
  );
  expect((await f.cli(["read", "--pane", f.target])).value.text).toContain(
    "SCREEN_RETAINED",
  );
  expect(await f.cli(["key", "--pane", f.target, "enter"])).toMatchObject({
    code: 1,
    error: { code: "DISCONNECTED" },
  });
});

test("CLI settings revoke existing access and reject ambiguous tabs and SSH targets", async () => {
  const f = await setup();
  const sshId = randomUUID(),
    host = hostSchema.parse({
      id: randomUUID(),
      name: "SSH",
      address: "127.0.0.1",
      username: "test",
    });
  await suite.page.evaluate(
    async ({ sshId, host }) => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.workspaces.forEach((w) => {
        w.name = "같은 이름";
      });
      b.document.hosts.push(host);
      b.document.workspaces.push({
        id: crypto.randomUUID(),
        name: "SSH",
        root: { kind: "pane", id: sshId, hostId: host.id },
      });
      await window.passport.call("save", b.document);
    },
    { sshId, host },
  );
  expect(await f.cli(["read", "--tab", "같은 이름"])).toMatchObject({
    code: 1,
    error: { code: "AMBIGUOUS_TARGET" },
  });
  expect(
    (await f.cli(["list"])).value.some((p: any) => p.paneId === sshId),
  ).toBe(false);
  expect(await f.cli(["read", "--pane", sshId])).toMatchObject({
    code: 1,
    error: { code: "NOT_FOUND" },
  });
  await suite.page.getByRole("button", { name: "설정", exact: true }).click();
  await suite.page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "로컬 터미널", exact: true })
    .click();
  await suite.page.getByLabel("CLI 접근", { exact: true }).selectOption("read");
  await expect
    .poll(async () => (await boot()).document.settings.terminal.cliAccess)
    .toBe("read");
  expect(await f.cli(["identify"])).toMatchObject({
    code: 1,
    error: { code: "UNAUTHORIZED" },
  });
  // A fresh PTY gets read-only access; the old token never upgrades or revives.
  await suite.page.evaluate(async (id) => {
    const b = await window.passport.call("bootstrap", undefined);
    const pane = b.document.workspaces
      .flatMap((w) => (w.root.kind === "pane" ? [w.root] : []))
      .find((p) => p.id === id)!;
    await window.passport.call("session.connect", { id, hostId: pane.hostId });
  }, f.source);
  // Switch back to the source tab so its actual shell prompt is observable.
  await suite.page
    .getByRole("button", { name: "같은 이름", exact: true })
    .first()
    .click();
  await expect(
    suite.page.locator(".view:not([hidden]) .xterm-rows"),
  ).toContainText(/\$\s*$/);
  const readonly = await coordinator(suite.page, f.source);
  expect(await readonly(["read", "--pane", f.target])).toMatchObject({
    ok: true,
  });
  expect(await readonly(["send", "--pane", f.target, "no"])).toMatchObject({
    code: 1,
    error: { code: "READ_ONLY" },
  });
});
