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
import { shortcutSettingsSchema } from "../src/shared/shortcuts";
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

it("migrates the old new-tab default without overwriting a customized binding", () => {
  const legacy = {
    copy: "Platform+C",
    paste: "Platform+V",
    search: "Mod+Shift+F",
    nextPane: "Alt+ArrowRight",
    previousPane: "Alt+ArrowLeft",
    newTab: "Mod+Shift+T",
  };
  const migrated = shortcutSettingsSchema.parse(legacy);
  expect(migrated.darwin.newTab).toEqual(["Meta+N"]);
  expect(migrated.win32.newWindow).toEqual(["Ctrl+Shift+N"]);
  expect(() => validateShortcuts(migrated)).not.toThrow();
  const custom = shortcutSettingsSchema.parse({
    ...legacy,
    newTab: "Mod+Shift+Y",
  });
  expect(custom.darwin.newTab).toEqual(["Meta+Shift+Y"]);
  const conflict = shortcutSettingsSchema.parse({
    ...legacy,
    activity: "Ctrl+N",
  });
  expect(conflict.win32.newTab).toEqual(["Ctrl+Shift+T"]);
  expect(conflict.darwin.newTab).toEqual(["Meta+N"]);
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
