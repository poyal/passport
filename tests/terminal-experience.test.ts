import { it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ActivityService } from "../src/main/activity";
import { ActivityBanners } from "../src/main/activity-banners";
import { Store } from "../src/main/store";
import {
  emptyDocument,
  documentSchema,
  type Activity,
} from "../src/shared/model";
import { defaultShortcuts, migrateShortcuts } from "../src/shared/shortcuts";
import { validateShortcuts } from "../src/shared/advanced";
import {
  assertTerminalCapacity,
  localWorkspace,
} from "../src/shared/local-workspace";
import {
  availableFont,
  bundledFonts,
  fontCatalog,
  terminalFontFamily,
} from "../src/shared/fonts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    fs.rmSync(folder, { recursive: true, force: true });
});
it("reads only the visited terminal, persists history, and preserves pending approvals", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "passport-activity-read-"),
  );
  folders.push(directory);
  const store = new Store(directory, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  let viewed: string | null = null;
  const notify = vi.fn(),
    changed = vi.fn();
  const service = new ActivityService(store.db, {
    workspace: () => "workspace",
    notify,
    changed,
    viewed: (paneId) => paneId === viewed,
    ready: () => {},
    error: () => {},
  });
  const send = (paneId: string) => {
    const generation = randomUUID();
    const auth = service.register(paneId, generation, {
      claude: true,
      codex: true,
    });
    const event = {
      token: auth.PASSPORT_TOKEN,
      generation,
      source: "claude",
      run: paneId,
      session: paneId,
    };
    service.receive({ ...event, event: "run-start", agentRun: paneId });
    service.receive({ ...event, event: "permission", request: "approval" });
    return event;
  };
  try {
    const first = send("first");
    send("second");
    expect(service.list().every((row) => !row.read)).toBe(true);
    service.readPane("first");
    expect(service.list().find((row) => row.paneId === "first")).toMatchObject({
      read: true,
      resolved: false,
    });
    expect(service.list().find((row) => row.paneId === "second")).toMatchObject(
      { read: false, resolved: false },
    );
    const count = changed.mock.calls.length;
    service.readPane("first");
    expect(changed).toHaveBeenCalledTimes(count);
    viewed = "first";
    service.receive({ ...first, event: "permission", request: "another" });
    expect(service.list()[0]).toMatchObject({ read: true, resolved: false });
    expect(notify).toHaveBeenCalledTimes(2);
    viewed = null;
    service.receive({ ...first, event: "completed", turn: "background" });
    expect(service.list()[0].read).toBe(false);
    expect(notify).toHaveBeenCalledTimes(3);
    const rows = store.db.prepare("SELECT value FROM activity").all() as {
      value: string;
    }[];
    expect(rows).toHaveLength(4);
    expect(
      rows.map((row) => JSON.parse(row.value)).filter((row) => row.read),
    ).toHaveLength(2);
  } finally {
    await service.close();
    store.close();
  }
});

it("closes only read or removed activity banners, including retained delivered notifications", () => {
  const registry = new ActivityBanners(),
    first = { close: vi.fn() },
    second = { close: vi.fn() },
    testBanner = { close: vi.fn() };
  registry.track(first, "first");
  registry.track(second, "second");
  registry.track(testBanner);
  registry.sync([
    { id: "first", read: true },
    { id: "second", read: false },
  ] as Activity[]);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(second.close).not.toHaveBeenCalled();
  expect(testBanner.close).not.toHaveBeenCalled();
  registry.sync([]);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(second.close).toHaveBeenCalledTimes(1);
  registry.close();
  expect(testBanner.close).toHaveBeenCalledTimes(1);
});

it("migrates legacy defaults once and preserves customized shortcuts and cross-platform conflicts", () => {
  const legacy: Record<string, string> = {
    ...defaultShortcuts,
    newTab: "Mod+Shift+T",
  };
  delete legacy.newWindow;
  const migrated = migrateShortcuts(legacy) as Record<string, string>;
  expect(migrated).toMatchObject({ newTab: "Mod+N", newWindow: "Mod+Shift+N" });
  expect(() => validateShortcuts(migrated)).not.toThrow();
  expect(migrateShortcuts({ ...legacy, newTab: "Mod+Shift+Y" })).toMatchObject({
    newTab: "Mod+Shift+Y",
    newWindow: "Mod+Shift+N",
  });
  const conflict = migrateShortcuts({
    ...legacy,
    search: "Meta+Shift+N",
    activity: "Ctrl+N",
  }) as Record<string, string>;
  expect(conflict).toMatchObject({
    newTab: "Mod+Shift+T",
    newWindow: "",
    search: "Meta+Shift+N",
    activity: "Ctrl+N",
  });
  expect(() => validateShortcuts(conflict)).not.toThrow();
  expect(
    migrateShortcuts({ ...defaultShortcuts, newTab: "Mod+Shift+T" }),
  ).toMatchObject({ newTab: "Mod+Shift+T" });
  expect(
    documentSchema.parse(emptyDocument()).settings.shortcuts,
  ).toMatchObject({ newTab: "Mod+N", newWindow: "Mod+Shift+N" });
});

it("new local workspaces inherit the configured shell and enforce the shared terminal limit", () => {
  const document = emptyDocument();
  document.settings.terminal.shell = "cmd";
  for (let index = 0; index < 32; index++)
    document.workspaces.push(
      localWorkspace(document, "C:\\Users\\한글", randomUUID(), randomUUID()),
    );
  expect(document.workspaces[0].root).toMatchObject({
    kind: "pane",
    local: {
      shell: "cmd",
      cwd: "C:\\Users\\한글",
      profiles: { mode: "inherit", ids: [] },
    },
  });
  expect(() => assertTerminalCapacity(document)).toThrow("32개");
  expect(() =>
    localWorkspace(document, "/tmp", randomUUID(), randomUUID()),
  ).toThrow("32개");
  document.workspaces.pop();
  expect(() => assertTerminalCapacity(document)).not.toThrow();
});

it("font catalog exposes seven bundled faces and only installed OS recommendations without duplicates", () => {
  const mac = fontCatalog(
    ["Menlo", "Monaco", "Arial", "JetBrains Mono", "@Vertical"],
    "darwin",
  );
  expect(mac.filter((font) => font.group === "앱 내장")).toHaveLength(7);
  expect(
    mac.filter((font) => font.group === "OS 추천").map((font) => font.family),
  ).toEqual(["Menlo", "Monaco"]);
  expect(
    mac.some(
      (font) => font.family === "Consolas" || font.family === "@Vertical",
    ),
  ).toBe(false);
  const windows = fontCatalog(
    ["Consolas", "CONSOLAS", "Lucida Console", "Cascadia Mono"],
    "win32",
  );
  expect(
    windows.filter((font) => font.family.toLowerCase() === "consolas"),
  ).toHaveLength(1);
  expect(
    fontCatalog([], "win32").every((font) => font.group === "앱 내장"),
  ).toBe(true);
  for (const font of bundledFonts) expect(availableFont(font, [])).toBe(font);
  expect(availableFont("Missing", ["Menlo"])).toBe("JetBrains Mono");
  expect(terminalFontFamily("D2Coding")).toBe(
    '"D2Coding", "JetBrains Mono", monospace',
  );
});
