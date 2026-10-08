import { describe, it, expect } from "vitest";
import { emptyDocument, documentSchema } from "../src/shared/model";
import { decodePortable, encodePortable } from "../src/main/portable";
import {
  defaultShortcuts,
  migrateShortcuts,
  shortcutSettingsSchema,
  validateShortcuts,
  shortcutMatch,
  normalizeShortcut,
  shortcutFromEvent,
  managedTerminalKey,
  managedFileMenuKey,
  ignoreShortcutMenu,
} from "../src/shared/shortcuts";

const legacy = {
  copy: "Platform+C",
  paste: "Platform+V",
  search: "Mod+Shift+F",
  nextPane: "Alt+ArrowRight",
  previousPane: "Alt+ArrowLeft",
  newTab: "Mod+N",
  newWindow: "Mod+Shift+N",
  activity: "Mod+Shift+I",
  recentActivity: "Mod+Shift+U",
};
const event = (key: string, fields = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...fields,
});
describe("platform shortcut settings", () => {
  it("uses independent valid defaults and copies without terminal interrupt on Windows", () => {
    const settings = emptyDocument().settings.shortcuts;
    expect(() => validateShortcuts(settings)).not.toThrow();
    expect(settings.win32.copy).toEqual(["Ctrl+C"]);
    expect(settings.win32.interrupt).toEqual(["Ctrl+Shift+C"]);
    expect(settings.darwin.copy).toEqual(["Meta+C"]);
    for (const lane of Object.values(settings))
      for (const keys of Object.values(lane)) expect(keys).toHaveLength(1);
    const key = event("c", { ctrlKey: true });
    expect(shortcutMatch(key, settings.win32.copy, false)).toBe(true);
    expect(shortcutMatch(key, settings.win32.interrupt, false)).toBe(false);
    expect(shortcutMatch(key, settings.darwin.interrupt, true)).toBe(true);
  });
  it("migrates legacy defaults, keeps custom and disabled keys, and resolves added defaults per OS", () => {
    const settings = shortcutSettingsSchema.parse({
      ...legacy,
      search: "Meta+Shift+N",
      copy: "",
      paste: "Ctrl+Shift+Y",
    });
    expect(settings.darwin.newWindow).toEqual([]);
    expect(settings.win32.newWindow).toEqual(["Ctrl+Shift+N"]);
    expect(settings.darwin.copy).toEqual([]);
    expect(settings.win32.copy).toEqual([]);
    expect(settings.win32.paste).toEqual(["Ctrl+Shift+Y"]);
    expect(settings.darwin.paste).toEqual(["Ctrl+Shift+Y"]);
    expect(shortcutSettingsSchema.parse(settings)).toEqual(settings);
    const defaults = shortcutSettingsSchema.parse(legacy);
    expect(defaults).toEqual(defaultShortcuts);
    const priority = shortcutSettingsSchema.parse({
      ...legacy,
      newTab: "Ctrl+Shift+C",
    });
    expect(priority.win32.newTab).toEqual(["Ctrl+Shift+C"]);
    expect(priority.win32.interrupt).toEqual([]);
  });
  it("validates within each OS and overlapping scope with actionable conflicts", () => {
    const settings = structuredClone(defaultShortcuts);
    settings.win32.fileSelectAll = ["Ctrl+C"]; // Files and terminal do not overlap.
    settings.darwin.newTab = ["Ctrl+Shift+C"];
    expect(() => validateShortcuts(settings)).not.toThrow();
    settings.win32.newTab = ["Ctrl+C"];
    expect(() => validateShortcuts(settings)).toThrow(
      /Windows.*복사.*새 탭.*중복/,
    );
    settings.win32.newTab = ["Ctrl+N", "Ctrl+n"];
    expect(() => validateShortcuts(settings)).toThrow("한 개");
  });
  it("keeps only the first stored binding in both lanes without mutating input", () => {
    const raw = structuredClone(defaultShortcuts);
    raw.darwin.newTab = ["Meta+y", "Meta+Shift+F"];
    raw.darwin.copy = [];
    raw.win32.paste = ["Ctrl+v", "Ctrl+Shift+V"];
    raw.win32.fileMenu = ["Shift+F10", "ContextMenu"];
    raw.win32.zoomIn = ["Ctrl+Equal", "Ctrl+Shift+Equal"];
    const before = structuredClone(raw);
    const result = shortcutSettingsSchema.parse(raw);
    expect(result.darwin.newTab).toEqual(["Meta+Y"]);
    expect(result.darwin.copy).toEqual([]);
    expect(result.win32.paste).toEqual(["Ctrl+V"]);
    expect(result.win32.fileMenu).toEqual(["Shift+F10"]);
    expect(result.win32.zoomIn).toEqual(["Ctrl+Equal"]);
    expect(shortcutSettingsSchema.parse(result)).toEqual(result);
    expect(raw).toEqual(before);
    expect(() => validateShortcuts(result)).not.toThrow();
  });
  it("records physical keys across layouts, modifiers, symbols and function keys", () => {
    expect(
      shortcutFromEvent(event("ㅊ", { code: "KeyC", ctrlKey: true })),
    ).toBe("Ctrl+C");
    expect(normalizeShortcut("Mod++", "darwin")).toBe("Meta+Equal");
    expect(
      shortcutMatch(
        event("+", { code: "Equal", ctrlKey: true, shiftKey: true }),
        ["Ctrl+Shift+Equal"],
        false,
      ),
    ).toBe(true);
    expect(shortcutMatch(event("F2"), ["F2"], false)).toBe(true);
    expect(shortcutMatch(event("Delete"), ["Delete"], false)).toBe(true);
    expect(
      shortcutMatch(
        event("c", { ctrlKey: true, isComposing: true }),
        ["Ctrl+C"],
        false,
      ),
    ).toBe(false);
    for (const key of [
      "A",
      "Shift+A",
      "Escape",
      "Tab",
      "Enter",
      "ArrowLeft",
      "Super+N",
      "Ctrl+",
    ])
      expect(() => normalizeShortcut(key, "darwin")).toThrow();
  });
  it("suppresses removed secondary defaults independently of editable defaults", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const mac = platform === "darwin";
      const plus = event("+", {
        code: "Equal",
        ctrlKey: !mac,
        metaKey: mac,
        shiftKey: true,
      });
      expect(shortcutMatch(plus, defaultShortcuts[platform].zoomIn, mac)).toBe(
        false,
      );
      expect(managedTerminalKey(plus, platform)).toBe(true);
      for (const menu of [
        event("F10", { shiftKey: true }),
        event("ContextMenu"),
      ]) {
        expect(managedFileMenuKey(menu, platform)).toBe(true);
        const settings = structuredClone(defaultShortcuts);
        settings[platform].fileMenu = [];
        expect(ignoreShortcutMenu("files", menu, settings, platform)).toBe(
          true,
        );
        expect(ignoreShortcutMenu("editing", menu, settings, platform)).toBe(
          false,
        );
      }
    }
    const paste = event("v", { ctrlKey: true, shiftKey: true });
    expect(shortcutMatch(paste, defaultShortcuts.win32.paste, false)).toBe(
      false,
    );
    expect(managedTerminalKey(paste, "win32")).toBe(true);
  });
  it("preserves explicit removal and blocks old xterm control bindings", () => {
    const settings = structuredClone(defaultShortcuts);
    settings.win32.copy = [];
    settings.win32.paste = [];
    settings.win32.interrupt = [];
    settings.win32.eof = [];
    settings.win32.suspend = [];
    expect(shortcutSettingsSchema.parse(settings)).toEqual(settings);
    for (const key of ["c", "d", "z", "v"]) {
      expect(managedTerminalKey(event(key, { ctrlKey: true }), "win32")).toBe(
        true,
      );
      expect(
        shortcutMatch(
          event(key, { ctrlKey: true }),
          settings.win32.copy,
          false,
        ),
      ).toBe(false);
    }
    expect(managedTerminalKey(event("a", { ctrlKey: true }), "win32")).toBe(
      false,
    );
  });
  it("round-trips both lanes and removals through document and portable data", async () => {
    const document = emptyDocument();
    document.settings.shortcuts.win32.copy = [];
    document.settings.shortcuts.darwin.newTab = ["Meta+Y", "Meta+Shift+Y"];
    const expected = shortcutSettingsSchema.parse(document.settings.shortcuts);
    const decoded = await decodePortable(
      await encodePortable({
        format: "passport",
        version: 2,
        document,
        profiles: [],
      }),
    );
    expect(decoded.document.settings.shortcuts).toEqual(expected);
    expect(documentSchema.parse(document).settings.shortcuts).toEqual(expected);
    // An old, unencrypted backup must migrate at decoding, not only encoding.
    const oldBackup = await decodePortable(
      JSON.stringify({
        format: "passport",
        version: 2,
        document,
        profiles: [],
      }),
    );
    expect(oldBackup.document.settings.shortcuts).toEqual(expected);
    expect(document.settings.shortcuts.darwin.newTab).toHaveLength(2);
    const migrated = shortcutSettingsSchema.parse(migrateShortcuts(legacy));
    expect(migrateShortcuts(migrated)).toEqual(migrated);
  });
  it("routes native menu accelerators only for the active shortcut context", () => {
    const settings = structuredClone(defaultShortcuts);
    settings.darwin.copy = [];
    const copy = event("c", { metaKey: true });
    expect(ignoreShortcutMenu("terminal", copy, settings, "darwin")).toBe(true);
    expect(ignoreShortcutMenu("standard", copy, settings, "darwin")).toBe(
      false,
    );
    expect(
      ignoreShortcutMenu(
        "recording",
        event("q", { metaKey: true }),
        settings,
        "darwin",
      ),
    ).toBe(true);
    expect(
      ignoreShortcutMenu(
        "dialog",
        event("n", { metaKey: true }),
        settings,
        "darwin",
      ),
    ).toBe(false);
    expect(
      ignoreShortcutMenu(
        "editing",
        event("n", { metaKey: true }),
        settings,
        "darwin",
      ),
    ).toBe(false);
    settings.win32.fileSelectAll = [];
    expect(
      ignoreShortcutMenu(
        "files",
        event("a", { ctrlKey: true }),
        settings,
        "win32",
      ),
    ).toBe(true);
    expect(
      ignoreShortcutMenu(
        "terminal",
        event("q", { metaKey: true }),
        settings,
        "darwin",
      ),
    ).toBe(false);
  });
  it("rejects partial lanes, malformed bindings and oversized key lists", () => {
    expect(shortcutSettingsSchema.safeParse({ win32: {} }).success).toBe(false);
    const settings = structuredClone(defaultShortcuts);
    settings.win32.newTab = ["Ctrl+NoSuchKey"];
    expect(shortcutSettingsSchema.safeParse(settings).success).toBe(false);
    settings.win32.newTab = Array(17).fill("Ctrl+N");
    expect(shortcutSettingsSchema.safeParse(settings).success).toBe(false);
  });
});
