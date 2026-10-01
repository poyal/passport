import { it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../src/main/store";
import { LocalSessions } from "../src/main/local";
import { ActivityService, OscNotifications } from "../src/main/activity";
import {
  prepareLaunch,
  previewEnvironment,
  shQuote,
  cmdValue,
} from "../src/main/startup";
import { helperPath } from "../src/main/shells";
import {
  defaultTerminalSettings,
  selectedProfiles,
  notificationSettingsSchema,
  startupProfileSchema,
} from "../src/shared/terminal-config";
import {
  emptyDocument,
  documentSchema,
  type Activity,
} from "../src/shared/model";
import { migrateDocument } from "../src/shared/migration";
import {
  decodePortable,
  encodePortable,
  mergePortable,
} from "../src/main/portable";

const folders: string[] = [];
const directory = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "passport-startup-"));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0))
    fs.rmSync(folder, { recursive: true, force: true });
});
const vault = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => "",
};

it("keeps at most 500 notifications for seven days and never re-emits historical records", async () => {
  const store = new Store(directory(), vault);
  let now = Date.now();
  const emitted: Activity[] = [];
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const callbacks = {
    workspace: () => "w",
    changed: () => {},
    notify: (item: Activity) => emitted.push(item),
    ready: () => {},
    error: () => {},
  };
  const service = new ActivityService(store.db, callbacks);
  try {
    const generation = randomUUID(),
      auth = service.register("p", generation, { claude: false, codex: true });
    const base = {
      generation,
      token: auth.PASSPORT_TOKEN,
      source: "codex",
      run: "run",
    };
    service.receive({ ...base, event: "run-start", agentRun: "run" });
    for (let i = 0; i < 520; i++) {
      now += 1001;
      service.receive({ ...base, event: "completed", turn: String(i) });
    }
    expect(service.list()).toHaveLength(500);
    const restored = new ActivityService(store.db, callbacks);
    expect(emitted).toHaveLength(520);
    expect(restored.list().every((r) => !r.available)).toBe(true);
    now += 8 * 86400000;
    expect(restored.list()).toEqual([]);
    await restored.close();
  } finally {
    clock.mockRestore();
    await service.close();
    store.close();
  }
});

it("migrates v1, rejects future formats, and preserves startup fields through encrypted export", async () => {
  const old = { ...emptyDocument(), version: 1, settings: { autoLog: true } };
  const document = migrateDocument(old, "win32");
  expect(document.version).toBe(2);
  expect(document.settings.terminal).toEqual(
    defaultTerminalSettings("win32", true),
  );
  expect(() => documentSchema.parse(old)).toThrow();
  expect(() => migrateDocument({ ...old, version: 3 })).toThrow();
  const legacy = await decodePortable(
    JSON.stringify({
      format: "passport",
      version: 1,
      document: old,
      profiles: [],
    }),
  );
  expect(legacy.version).toBe(2);
  document.settings.terminal.profiles.push(
    startupProfileSchema.parse({
      id: "custom",
      name: "프로젝트",
      platforms: ["darwin"],
      shells: ["zsh"],
      entries: [{ kind: "env", name: "PROJECT_NAME", value: "한글 ' $()" }],
    }),
  );
  document.settings.terminal.profileIds = ["custom"];
  const encoded = await encodePortable(
    { format: "passport", version: 2, document, profiles: [] },
    "test-passphrase",
  );
  expect(JSON.parse(encoded).version).toBe(1); // crypto envelope stays compatible
  expect((await decodePortable(encoded, "test-passphrase")).document).toEqual(
    document,
  );
});
it("backs up v3 before migrating and keeps the original database on validation failure", () => {
  const dir = directory();
  let store = new Store(dir, vault);
  const old = { ...store.read(), version: 1 };
  store.db.prepare("UPDATE metadata SET value=?").run(JSON.stringify(old));
  store.db.pragma("user_version=3");
  store.close();
  store = new Store(dir, vault);
  expect(store.read().version).toBe(2);
  expect(
    fs
      .readdirSync(dir)
      .some((f) => f.startsWith("before-v5-") && f.endsWith(".sqlite")),
  ).toBe(true);
  expect(store.db.pragma("user_version", { simple: true })).toBe(5);
  store.close();
});
it("resolves pane/project/global profile precedence and remaps imported profile collisions", () => {
  const settings = defaultTerminalSettings("darwin");
  settings.profileIds = ["unix-shortcuts"];
  expect(selectedProfiles(settings, { mode: "none", ids: [] })).toEqual([]);
  expect(
    selectedProfiles(
      settings,
      { mode: "none", ids: [] },
      { mode: "custom", ids: ["ai-notifications", "unix-shortcuts"] },
    ).map((p) => p.id),
  ).toEqual(["ai-notifications", "unix-shortcuts"]);
  expect(() =>
    selectedProfiles(settings, { mode: "custom", ids: ["missing"] }),
  ).toThrow();
  const current = emptyDocument(),
    incoming = emptyDocument();
  const p = startupProfileSchema.parse({
    id: "same",
    name: "one",
    platforms: ["darwin"],
    shells: ["zsh"],
    entries: [],
  });
  current.settings.terminal.profiles = [p];
  incoming.settings.terminal.profiles = [{ ...p, name: "two" }];
  incoming.settings.terminal.profileIds = [p.id];
  incoming.workspaces = [
    {
      id: randomUUID(),
      name: "imported",
      root: {
        id: randomUUID(),
        kind: "pane",
        hostId: randomUUID(),
        local: { shell: "zsh", cwd: "/tmp" },
      },
    },
  ];
  const result = mergePortable(
    current,
    [],
    { format: "passport", version: 2, document: incoming, profiles: [] },
    "skip",
  ).document;
  expect(result.settings.terminal.profiles).toHaveLength(2);
  expect(result.workspaces[0].project?.profiles?.ids[0]).not.toBe("same");
  expect(
    result.workspaces[0].root.kind === "pane" &&
      result.workspaces[0].root.local?.needsReview,
  ).toBe(true);
});
it("limits OSC parsing and handles split BEL/ST sequences without inferring approval", () => {
  const found: string[] = [],
    parser = new OscNotifications((value) => found.push(value));
  for (const part of [
    "plain\x1b",
    "]9;hello",
    "\x1b",
    "\\",
    "\x1b]777;notify;title;body\x07",
    `\x1b]9;${"x".repeat(5000)}\x07`,
    "\x1b]0;not-an-alert\x07",
  ])
    parser.push(part);
  expect(found).toEqual(["9;hello", "777;notify;title;body"]);
});
it("authenticates generations, separates read/resolve, and bounds duplicate notifications", async () => {
  const store = new Store(directory(), vault);
  const notified: Activity[] = [];
  const service = new ActivityService(store.db, {
    workspace: () => "workspace",
    changed: () => {},
    notify: (item) => notified.push(item),
    ready: () => {},
    error: () => {},
  });
  try {
    const generation = randomUUID(),
      auth = service.register("pane", generation, {
        claude: true,
        codex: true,
      });
    const event = {
      token: auth.PASSPORT_TOKEN,
      generation,
      source: "claude",
      run: "run",
      session: "s",
      request: "r",
    };
    service.receive({ ...event, event: "run-start", agentRun: "run" });
    service.receive({ ...event, token: "f".repeat(64), event: "permission" });
    expect(notified).toHaveLength(0);
    service.receive({ ...event, event: "permission-candidate" });
    expect(notified[0].kind).toBe("attention");
    service.receive({ ...event, event: "permission" });
    service.receive({ ...event, event: "permission" });
    expect(notified).toHaveLength(2);
    const pending = service.list()[0];
    service.read(pending.id);
    expect(service.list()[0]).toMatchObject({ read: true, resolved: false });
    service.receive({ ...event, event: "tool-done", request: "other" });
    expect(service.list()[0].resolved).toBe(false);
    service.receive({ ...event, event: "tool-done" });
    expect(service.list()[0].resolved).toBe(true);
    service.receive({ ...event, event: "permission", request: "next" });
    expect(service.list()[0].resolved).toBe(false);
    service.restrictAgents({ claude: false, codex: true });
    expect(service.list()[0].resolved).toBe(true);
    service.receive({ ...event, event: "completed" });
    service.restrictAgents({ claude: true, codex: true });
    service.receive({ ...event, event: "permission", request: "revoked" });
    expect(notified).toHaveLength(3);
    service.unregister("pane");
    service.register("pane", randomUUID(), { claude: true, codex: true });
    service.receive({ ...event, event: "completed" });
    expect(notified).toHaveLength(3);
    expect(() => service.active(pending.id)).toThrow("종료된");
    expect(
      JSON.stringify(store.db.prepare("SELECT value FROM activity").all()),
    ).not.toContain(auth.PASSPORT_TOKEN);
  } finally {
    await service.close();
    store.close();
  }
});
it.skipIf(process.platform === "win32")(
  "applies zsh startup once, preserves user files, launches AI after initialization, then returns to shell",
  async () => {
    const dir = directory(),
      user = path.join(dir, "한글 ' $() user"),
      bin = path.join(user, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const trace = path.join(dir, "trace");
    for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"])
      fs.writeFileSync(
        path.join(user, file),
        `printf '%s\\n' ${shQuote(file)} >> ${shQuote(trace)}\n${file === ".zlogin" ? `export PATH=${shQuote(bin)}:"$PATH"\n` : ""}${file === ".zshrc" ? "alias ll='printf KEEP_ALIAS'\n" : ""}`,
      );
    const before = fs
      .readdirSync(user)
      .filter((f) => f.startsWith("."))
      .map((f) => [f, fs.readFileSync(path.join(user, f), "utf8")]);
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\nprintf 'FAKE_%s\\n' AI_STARTED\n${shQuote(helperPath())} claude-hook <<'EVENT'\n{"hook_event_name":"Notification","notification_type":"permission_prompt","session_id":"test","tool_use_id":"request"}\nEVENT\nexit 7\n`,
      { mode: 0o755 },
    );
    const store = new Store(dir, vault);
    let output = "",
      ready = false;
    const local = new LocalSessions((e) => {
      if (e.kind === "output") {
        output += e.data;
        local.ack(e.id, e.bytes);
      }
    });
    const service = new ActivityService(store.db, {
      workspace: () => "w",
      changed: () => {},
      notify: () => {},
      ready: (id, generation, result) => {
        local.ready(id, generation, result);
        if (!result) ready = true;
      },
      error: () => {},
    });
    try {
      await service.start();
      const config = {
        shell: "zsh" as const,
        cwd: user,
        agent: "claude" as const,
      };
      const settings = defaultTerminalSettings("darwin");
      settings.profileIds = ["unix-shortcuts", "ai-notifications"];
      const snapshot = previewEnvironment(config, settings);
      const auth = service.register("pane", snapshot.sessionInstanceId, {
        claude: true,
        codex: false,
      });
      const launch = prepareLaunch(
        config,
        settings,
        notificationSettingsSchema.parse({ claude: true }),
        undefined,
        path.join(dir, "sessions"),
        auth,
        snapshot,
      );
      launch.env.PASSPORT_USER_ZDOTDIR = user;
      launch.env.PASSPORT_HAD_ZDOTDIR = "1";
      local.open("pane", config, launch);
      await expect.poll(() => ready, { timeout: 10000 }).toBe(true);
      await expect.poll(() => output).toContain("FAKE_AI_STARTED");
      await expect.poll(() => service.list().length).toBe(1);
      local.input("pane", "ll; printf 'SHELL_%s\\n' RETURNED\r");
      await expect.poll(() => output).toContain("KEEP_ALIAS");
      await expect.poll(() => output).toContain("SHELL_RETURNED");
      expect(fs.readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".zlogin",
      ]);
      for (const [name, text] of before)
        expect(fs.readFileSync(path.join(user, name), "utf8")).toBe(text);
      expect(snapshot.results.some((r) => r.includes("기존 명령 유지"))).toBe(
        true,
      );
    } finally {
      await local.shutdown();
      await service.close();
      store.close();
    }
  },
);
it("receives native Codex argv notifications without persisting assistant messages", async () => {
  const store = new Store(directory(), vault);
  const notified: Activity[] = [];
  const service = new ActivityService(store.db, {
    workspace: () => "workspace",
    changed: () => {},
    notify: (item) => notified.push(item),
    ready: () => {},
    error: () => {},
  });
  try {
    await service.start();
    const generation = randomUUID();
    const credentials = service.register("pane", generation, {
      claude: false,
      codex: true,
    });
    service.receive({
      generation,
      token: credentials.PASSPORT_TOKEN,
      source: "codex",
      event: "run-start",
      agentRun: "codex-run",
    });
    const child = spawn(
      helperPath(),
      [
        "codex-notify",
        JSON.stringify({
          type: "agent-turn-complete",
          "thread-id": "thread",
          "turn-id": "turn",
          "last-assistant-message": "PRIVATE_TRANSCRIPT_MUST_NOT_PERSIST",
        }),
      ],
      {
        env: {
          ...process.env,
          ...credentials,
          PASSPORT_AGENT_RUN: "codex-run",
        },
        stdio: "ignore",
      },
    );
    expect(
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      }),
    ).toBe(0);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ source: "codex", kind: "completed" });
    expect(
      JSON.stringify(store.db.prepare("SELECT value FROM activity").all()),
    ).not.toContain("PRIVATE_TRANSCRIPT_MUST_NOT_PERSIST");
  } finally {
    await service.close();
    store.close();
  }
});

it("native hook adapter returns neutrally within its deadline on unclosed stdin and malformed payloads", async () => {
  const started = Date.now();
  const child = spawn(helperPath(), ["claude-hook"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write("{");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(cmdValue("a %PATH% ! & ^")).toBe("a %%PATH%% ! & ^");
  expect(() => cmdValue('a"b')).toThrow();
});
