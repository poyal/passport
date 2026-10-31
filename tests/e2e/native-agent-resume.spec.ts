import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { electron } from "../../scripts/e2e-electron.mjs";
import { closeCleanly } from "../fixtures/electron-exit";
import { aiServer } from "../fixtures/ai-server";
import type { AgentResume } from "../../src/shared/session-resume";

const sh = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const title =
  "real Codex and Claude resume saved conversations and reopen empty sessions after app restart";
test(title, async ({}, info) => {
  test.skip(
    process.env.PASSPORT_NATIVE_AI !== "1",
    "Requires installed Codex and Claude CLIs",
  );
  test.setTimeout(120_000);
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "passport-native-ai-")),
  );
  const home = path.join(dir, "home"),
    cwd = path.join(dir, "work");
  const codex = path.join(home, ".codex"),
    claude = path.join(home, ".claude");
  const appData = path.join(dir, "app");
  for (const p of [home, path.join(home, "Downloads"), cwd, codex, claude])
    await fs.mkdir(p, { recursive: true });
  const server = await aiServer();
  await fs.writeFile(
    path.join(codex, "config.toml"),
    `
model="fixture"
model_provider="fixture"
check_for_update_on_startup=false
log_dir=${JSON.stringify(path.join(codex, "log"))}
approval_policy="on-request"
approvals_reviewer="auto_review"
default_permissions=":workspace"
[model_providers.fixture]
name="Fixture"
base_url="${server.url}/v1"
wire_api="responses"
requires_openai_auth=false
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
`,
  );
  await fs.writeFile(
    path.join(claude, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: {
        [cwd.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true },
      },
      customApiKeyResponses: { approved: ["passport-fixture"] },
    }),
  );
  await fs.writeFile(
    path.join(home, ".zshrc"),
    `HISTFILE=/dev/null\nPROMPT='NATIVE_READY > '\nexport PATH=${sh(process.env.PATH || "")}\n`,
  );
  // Native clients must not inherit the operator's credentials, config or run ID.
  const clean = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [
      k,
      /^(CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|PASSPORT_)/.test(k) &&
      !/^(PASSPORT_E2E_|PASSPORT_SHUTDOWN_)/.test(k)
        ? undefined
        : v,
    ]),
  );
  const launch = () =>
    electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...clean,
        // Keep Electron's OS home and Keychain location intact. Isolate only
        // the shell startup files, native AI configuration and app data.
        ZDOTDIR: home,
        CODEX_HOME: codex,
        CLAUDE_CONFIG_DIR: claude,
        ANTHROPIC_API_KEY: "passport-fixture",
        ANTHROPIC_BASE_URL: server.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        RUST_LOG: "warn,codex_hooks=debug",
        PASSPORT_DATA_DIR: appData,
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
  let application = await launch(),
    page = await application.firstWindow();
  const rows = () => page.locator(".view:not([hidden]) .xterm-rows");
  const write = (id: string, data: string) =>
    page.evaluate((args) => window.passport.call("session.input", args), {
      id,
      data,
    });
  const submit = async (id: string, text: string) => {
    await write(id, text);
    // Codex treats a burst containing Enter as paste, rather than submit.
    await page.waitForTimeout(500);
    await write(id, "\r");
  };
  const stored = (id: string): Promise<AgentResume | undefined> =>
    application.evaluate(
      async ({ safeStorage }, { appData, id }) => {
        const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
        const db = new DatabaseSync(appData + "/passport.sqlite", {
          readOnly: true,
        });
        try {
          const row = db
            .prepare("SELECT agent FROM session_resume WHERE id=?")
            .get(id);
          return row?.agent
            ? JSON.parse(
                safeStorage.decryptString(Buffer.from(row.agent as Uint8Array)),
              )
            : undefined;
        } finally {
          db.close();
        }
      },
      { appData, id },
    );
  const select = async (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const ready = (id: string) =>
    expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.passport.call("bootstrap", undefined),
            )
          ).sessionStates.find((s) => s.id === id)?.environment?.status,
      )
      .toBe("ready");
  const create = async (name: string) => {
    const target = await page.evaluate(async (name) => {
      const t = await window.passport.call("terminal.create", undefined);
      const b = await window.passport.call("bootstrap", undefined);
      const w = b.document.workspaces.find((w) => w.id === t.workspaceId)!;
      w.name = name;
      if (w.root.kind !== "pane") throw new Error("Expected local pane");
      await window.passport.call("save", b.document);
      await window.passport.call("session.connect", {
        id: t.paneId,
        hostId: w.root.hostId,
      });
      return t;
    }, name);
    await select(name);
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.passport.call("bootstrap", undefined),
            )
          ).sessionStates.find((s) => s.id === target.paneId)?.environment
            ?.status,
      )
      .toBe("ready");
    return target.paneId;
  };
  try {
    await page.waitForSelector(".home-view");
    expect(
      await application.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable(),
      ),
      "OS encryption must be available",
    ).toBe(true);
    await page.evaluate(async (cwd) => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.sessionResume = true;
      Object.assign(b.document.settings.terminal, {
        shell: b.platform === "win32" ? "pwsh" : "zsh",
        cwd,
        profileIds: [],
        cliAccess: "off",
      });
      b.document.settings.notifications.codex = false;
      b.document.settings.notifications.claude = false;
      await window.passport.call("save", b.document);
    }, cwd);
    const codexId = await create("Native Codex");
    await submit(codexId, "codex");
    await expect(rows()).toContainText("Trust all and continue", {
      timeout: 20000,
    });
    await info.attach("native-hook-review", {
      body: await rows().innerText(),
      contentType: "text/plain",
    });
    // Review/trust only Passport's own hooks in this disposable native profile.
    await submit(codexId, "2");
    await expect(rows()).toContainText("OpenAI Codex", { timeout: 15000 });
    await submit(codexId, "passport fixture first");
    await expect(rows()).toContainText("PASSPORT_NATIVE_REPLY", {
      timeout: 20000,
    });
    await expect
      .poll(async () => (await stored(codexId))?.hasConversation)
      .toBe(true);
    const originalCodex = (await stored(codexId))!;
    expect(originalCodex.args).toEqual([]);
    const optionsId = await create("Native Codex Options");
    await submit(optionsId, "codex -a never -s danger-full-access");
    await expect(rows()).toContainText("OpenAI Codex", { timeout: 15000 });
    await submit(optionsId, "passport fixture options");
    await expect
      .poll(async () => (await stored(optionsId))?.hasConversation)
      .toBe(true);
    const originalOptions = (await stored(optionsId))!;
    expect(originalOptions.args).toEqual([
      "-a",
      "never",
      "-s",
      "danger-full-access",
    ]);
    expect(originalOptions.session).not.toBe(originalCodex.session);
    const claudeId = await create("Native Claude");
    await submit(claudeId, "claude --permission-mode plan");
    await expect(rows()).toContainText("Claude Code", { timeout: 20000 });
    await expect
      .poll(async () => (await stored(claudeId))?.hasConversation)
      .toBe(false);
    await submit(claudeId, "passport fixture first");
    await expect(rows()).toContainText("PASSPORT_NATIVE_REPLY", {
      timeout: 20000,
    });
    await expect
      .poll(async () => (await stored(claudeId))?.hasConversation)
      .toBe(true);
    const originalClaude = (await stored(claudeId))!;
    expect(originalClaude.args).toEqual(["--permission-mode", "plan"]);
    expect((await fs.stat(originalClaude.transcript!)).size).toBeGreaterThan(0);
    const emptyCodexId = await create("Native Empty Codex");
    await submit(emptyCodexId, "codex");
    await expect(rows()).toContainText("OpenAI Codex", { timeout: 15000 });
    await expect
      .poll(() => stored(emptyCodexId))
      .toMatchObject({ agent: "codex", running: true, args: [] });
    const emptyCodex = (await stored(emptyCodexId))!;
    // Some native Codex launches omit SessionStart before the first prompt.
    // Unknown and confirmed-empty both require a fresh launch, never resume.
    expect(emptyCodex.hasConversation).not.toBe(true);
    const emptyId = await create("Native Empty");
    await submit(emptyId, "claude --permission-mode plan");
    await expect
      .poll(async () => (await stored(emptyId))?.hasConversation)
      .toBe(false);
    const empty = (await stored(emptyId))!;
    await closeCleanly(application);
    application = await launch();
    page = await application.firstWindow();
    await page.evaluate(() => {
      const output = ((window as any).__nativeResumeOutput = {} as Record<
        string,
        string
      >);
      window.passport.onEvent((event) => {
        if (event.kind === "output")
          output[event.id] = ((output[event.id] || "") + event.data).slice(
            -200000,
          );
      });
    });
    await expect
      .poll(async () => (await stored(emptyId))?.session, { timeout: 20000 })
      .not.toBe(empty.session);
    await expect
      .poll(async () => (await stored(emptyId))?.hasConversation)
      .toBe(false);
    await expect(rows()).not.toContainText("No conversation found");
    await select("Native Empty Codex");
    await ready(emptyCodexId);
    if (!emptyCodex.session) {
      await expect(
        page.getByText(/Codex 대화 ID.*셸만 복원했습니다/),
      ).toBeVisible();
      // With no native identity the app must restore only the shell, not
      // guess whether an unobserved conversation exists. Follow its guidance.
      await submit(emptyCodexId, "codex");
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => (window as any).__nativeResumeOutput[id] || "",
            emptyCodexId,
          ),
        { timeout: 20000 },
      )
      .toContain("OpenAI Codex");
    expect((await stored(emptyCodexId))?.hasConversation).not.toBe(true);
    const beforeEmpty = server.requests();
    await submit(emptyCodexId, "passport fixture empty codex after restart");
    await expect
      .poll(
        () =>
          server
            .histories()
            .slice(beforeEmpty)
            .some(
              (history) =>
                history.includes(
                  "passport fixture empty codex after restart",
                ) &&
                !history.includes("passport fixture first") &&
                !history.includes("passport fixture options") &&
                !history.includes("PASSPORT_NATIVE_REPLY"),
            ),
        { timeout: 20000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await stored(emptyCodexId))?.hasConversation)
      .toBe(true);
    expect((await stored(emptyCodexId))?.session).toBeTruthy();
    expect((await stored(emptyCodexId))?.session).not.toBe(emptyCodex.session);
    await expect(rows()).not.toContainText("No conversation found");
    for (const [name, id, original] of [
      ["Native Codex", codexId, originalCodex],
      ["Native Codex Options", optionsId, originalOptions],
      ["Native Claude", claudeId, originalClaude],
    ] as const) {
      await select(name);
      await ready(id);
      // Check fresh PTY output, not the restored screen. Some native Codex
      // resumes omit SessionStart; the exact prior identity must survive that
      // interval. The next model request and native transcript independently
      // prove that the actual CLI continues this conversation.
      await expect
        .poll(
          () =>
            page.evaluate(
              (id) => (window as any).__nativeResumeOutput[id] || "",
              id,
            ),
          { timeout: 20000 },
        )
        .toContain("PASSPORT_NATIVE_REPLY");
      await expect
        .poll(async () => (await stored(id))?.session, { timeout: 20000 })
        .toBe(original.session);
      await expect
        .poll(async () => (await stored(id))?.hasConversation)
        .toBe(true);
      const before = server.requests();
      await submit(id, "passport fixture second");
      await expect
        .poll(() => server.requests(), { timeout: 20000 })
        .toBeGreaterThan(before);
      // Title generation can reach the API before the resumed conversation.
      // Require a new request carrying all three conversation messages.
      await expect
        .poll(
          () =>
            server
              .histories()
              .slice(before)
              .some(
                (history) =>
                  history.includes(
                    name === "Native Codex Options"
                      ? "passport fixture options"
                      : "passport fixture first",
                  ) &&
                  history.includes("PASSPORT_NATIVE_REPLY") &&
                  history.includes("passport fixture second"),
              ),
          { timeout: 20000 },
        )
        .toBe(true);
      expect(original.transcript).toBeTruthy();
      await expect
        .poll(() => fs.readFile(original.transcript!, "utf8"), {
          timeout: 10000,
        })
        .toContain("passport fixture second");
      await expect
        .poll(async () => (await stored(id))?.hasConversation)
        .toBe(true);
      expect((await stored(id))?.session).toBe(original.session);
      expect((await stored(id))?.args).toEqual(original.args);
      await expect(rows()).not.toContainText("No conversation found");
      await expect(rows()).not.toContainText(
        "This conversation is open in another app",
      );
    }
  } catch (error) {
    await info.attach("native-terminal", {
      body: await rows()
        .innerText()
        .catch(() => ""),
      contentType: "text/plain",
    });
    // Only the disposable fixture's native logs and metadata are collected.
    const files = await fs.readdir(codex, { recursive: true });
    const logs = Object.fromEntries(
      await Promise.all(
        files
          .filter((file) => file.endsWith(".log"))
          .map(async (file) => [
            file,
            (await fs.readFile(path.join(codex, file), "utf8")).slice(-100000),
          ]),
      ),
    );
    const agents = await application.evaluate(({ safeStorage }, appData) => {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const db = new DatabaseSync(appData + "/passport.sqlite", {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT agent FROM session_resume")
          .all()
          .map((row) =>
            row.agent
              ? JSON.parse(
                  safeStorage.decryptString(
                    Buffer.from(row.agent as Uint8Array),
                  ),
                )
              : null,
          );
      } finally {
        db.close();
      }
    }, appData);
    const environment = await page.evaluate(async () =>
      (await window.passport.call("bootstrap", undefined)).sessionStates.map(
        (state) => ({
          id: state.id,
          status: state.status,
          generation: state.generation,
          results: state.environment?.results,
        }),
      ),
    );
    const processes =
      process.platform === "win32"
        ? await application
            .evaluate(() => {
              const { execFileSync } =
                process.getBuiltinModule("node:child_process");
              // Restrict command lines to this disposable test app's descendants.
              const script = `$all = @(Get-CimInstance Win32_Process); $ids = [Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${process.pid}); do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); $all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3`;
              return JSON.parse(
                execFileSync(
                  "powershell.exe",
                  ["-NoProfile", "-NonInteractive", "-Command", script],
                  { encoding: "utf8", timeout: 10000 },
                ),
              );
            })
            .catch((error) => ({ error: String(error) }))
        : undefined;
    const diagnostics = JSON.stringify(
      { files, logs, agents, environment, processes },
      null,
      2,
    );
    await fs.mkdir(info.outputDir, { recursive: true });
    await fs.writeFile(info.outputPath("native-diagnostics.json"), diagnostics);
    await info.attach("native-diagnostics", {
      body: diagnostics,
      contentType: "application/json",
    });
    throw error;
  } finally {
    await closeCleanly(application);
    await server.close();
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
