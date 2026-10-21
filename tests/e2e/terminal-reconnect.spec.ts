import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { electron } from "../../scripts/e2e-electron.mjs";
import { closeCleanly } from "../fixtures/electron-exit";
import type { ProfileSelection } from "../../src/shared/terminal-config";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

test("reconnects the same local pane with fresh CLI credentials and current profiles without restarting the app", async () => {
  test.skip(
    process.platform !== "darwin",
    "Requires macOS zsh and the native helper.",
  );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-reconnect-"),
  );
  const startup = path.join(directory, "zsh"),
    bin = path.join(directory, "bin");
  await fs.mkdir(startup);
  await fs.mkdir(bin);
  const capture = path.join(directory, "capture.json"),
    alias = path.join(directory, "alias.txt");
  const script = path.join(directory, "mock-codex.cjs"),
    executable = path.join(bin, "codex");
  await fs.writeFile(
    path.join(startup, ".zshrc"),
    'HISTFILE=/dev/null\nPROMPT="RECONNECT_READY_${PASSPORT_SESSION_ID} > "\n',
  );
  await fs.writeFile(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    script,
    `
const fs = require('node:fs'), cp = require('node:child_process');
if (process.argv.includes('--version')) { console.log('codex fixture'); process.exit(0); }
const result = JSON.parse(cp.execFileSync('passport', ['identify', '--json'], {encoding:'utf8'}));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args: process.argv.slice(2), marker: process.env.RECONNECT_TEST_MARKER || null,
  customPath: process.env.PATH.split(':').includes(${JSON.stringify(bin)}),
  identified: result.ok, sourceMatches: result.value.sessionId === process.env.PASSPORT_SESSION_ID,
  tokenPresent: !!process.env.PASSPORT_CONTROL_TOKEN,
  pane: result.value.paneId, generation: result.value.sessionId
}));
`,
  );
  const application = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: path.join(directory, "app"),
      ZDOTDIR: startup,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForSelector(".home-view");
    const pid = application.process().pid;
    await page.evaluate(async (cwd) => {
      const boot = await window.passport.call("bootstrap", undefined);
      Object.assign(boot.document.settings.terminal, {
        shell: "zsh",
        cwd,
        cliAccess: "write",
        profileIds: [],
      });
      boot.document.settings.notifications.codex = true;
      await window.passport.call("save", boot.document);
    }, directory);
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    const initial = await page.evaluate(() =>
      window.passport.call("bootstrap", undefined),
    );
    const id = initial.sessionStates[0].id;
    const generations = new Set<string>();
    const steps: {
      profiles: ProfileSelection;
      revision: number;
      enabled: boolean;
      notifications: boolean;
    }[] = [
      {
        profiles: { mode: "none", ids: [] },
        revision: 1,
        enabled: false,
        notifications: false,
      },
      {
        profiles: { mode: "inherit", ids: [] },
        revision: 1,
        enabled: true,
        notifications: true,
      },
      {
        profiles: { mode: "inherit", ids: [] },
        revision: 2,
        enabled: true,
        notifications: true,
      },
      {
        profiles: { mode: "custom", ids: ["reconnect-test"] },
        revision: 3,
        enabled: true,
        notifications: false,
      },
      {
        profiles: { mode: "none", ids: [] },
        revision: 3,
        enabled: false,
        notifications: false,
      },
    ];
    for (const [index, step] of steps.entries()) {
      if (index) {
        await page.evaluate(
          async ({ id, step, bin }) => {
            const boot = await window.passport.call("bootstrap", undefined);
            const workspace = boot.document.workspaces.find(
              (w) => w.root.kind === "pane" && w.root.id === id,
            )!;
            if (workspace.root.kind !== "pane" || !workspace.root.local)
              throw new Error("Missing local pane");
            workspace.root.local.profiles = step.profiles;
            boot.document.settings.terminal.profiles = [
              {
                id: "reconnect-test",
                name: "Reconnect fixture",
                revision: step.revision,
                origin: "user",
                shells: ["zsh"],
                platforms: ["darwin"],
                entries: [
                  {
                    kind: "env",
                    name: "RECONNECT_TEST_MARKER",
                    value: `round-${step.revision}`,
                    overwrite: true,
                  },
                  {
                    kind: "alias",
                    name: "reconnect_probe",
                    command: "/bin/echo",
                    args: [`alias-${step.revision}`],
                    overwrite: true,
                  },
                  { kind: "path", value: bin, position: "prepend" },
                ],
              },
            ];
            boot.document.settings.terminal.profileIds = [
              "reconnect-test",
              "ai-notifications",
            ];
            await window.passport.call("save", boot.document);
            await window.passport.call("session.close", { id });
            await window.passport.call("session.connect", {
              id,
              hostId: workspace.root.hostId,
            });
          },
          { id, step, bin },
        );
      }
      await expect
        .poll(async () => {
          const boot = await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          );
          return boot.sessionStates.find((s) => s.id === id)?.environment
            ?.status;
        })
        .toBe("ready");
      const generation = await page.evaluate(async (id) => {
        const boot = await window.passport.call("bootstrap", undefined);
        return boot.sessionStates.find((state) => state.id === id)?.environment
          ?.sessionInstanceId;
      }, id);
      expect(generation).toBeTruthy();
      // A plain shell has no startup loader, so environment readiness does not
      // mean zsh has reached its first prompt. Match this connection's prompt;
      // the previous generation's prompt can remain in terminal scrollback.
      await expect(page.locator(".xterm-rows")).toContainText(
        `RECONNECT_READY_${generation} > `,
      );
      await fs.rm(capture, { force: true });
      await page.evaluate(
        ({ id, data }) => window.passport.call("session.input", { id, data }),
        {
          id,
          data: `if type reconnect_probe >/dev/null 2>&1; then reconnect_probe; else print missing; fi > ${quote(alias)}; ${step.enabled ? "codex" : quote(executable)} -a never -s danger-full-access resume\r`,
        },
      );
      await expect
        .poll(() => fs.readFile(capture, "utf8").catch(() => ""))
        .not.toBe("");
      const result = JSON.parse(await fs.readFile(capture, "utf8"));
      expect(result).toMatchObject({
        identified: true,
        sourceMatches: true,
        tokenPresent: true,
        pane: id,
        marker: step.enabled ? `round-${step.revision}` : null,
        customPath: step.enabled,
      });
      expect(result.args.slice(-5)).toEqual([
        "-a",
        "never",
        "-s",
        "danger-full-access",
        "resume",
      ]);
      expect(result.args.length > 5).toBe(step.notifications);
      expect((await fs.readFile(alias, "utf8")).trim()).toBe(
        step.enabled ? `alias-${step.revision}` : "missing",
      );
      expect(generations.has(result.generation)).toBe(false);
      generations.add(result.generation);
      expect(application.process().pid).toBe(pid);
      expect(application.windows()).toHaveLength(1);
    }
  } finally {
    await closeCleanly(application);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
