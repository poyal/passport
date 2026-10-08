import { z } from "zod";

export type ShortcutPlatform = "darwin" | "win32";
type Scope = "app" | "terminal" | "files";
export const shortcutActions = {
  copy: { label: "복사", scope: "terminal" },
  paste: { label: "붙여넣기", scope: "terminal" },
  interrupt: { label: "명령 중단", scope: "terminal" },
  eof: { label: "EOF 전송", scope: "terminal" },
  suspend: { label: "일시 정지", scope: "terminal" },
  cliImage: { label: "CLI 이미지 입력", scope: "terminal" },
  zoomIn: { label: "터미널 글자 확대", scope: "terminal" },
  zoomOut: { label: "터미널 글자 축소", scope: "terminal" },
  zoomReset: { label: "터미널 글자 크기 복원", scope: "terminal" },
  search: { label: "출력 검색", scope: "app" },
  nextPane: { label: "다음 패널", scope: "app" },
  previousPane: { label: "이전 패널", scope: "app" },
  newTab: { label: "새 탭 · 로컬 터미널", scope: "app" },
  newWindow: { label: "새 창 · 로컬 터미널", scope: "app" },
  activity: { label: "알림함", scope: "app" },
  recentActivity: { label: "최근 미확인 터미널", scope: "app" },
  fileSelectAll: { label: "파일 전체 선택", scope: "files" },
  fileRename: { label: "파일 이름 변경", scope: "files" },
  fileDelete: { label: "파일 삭제", scope: "files" },
  fileMenu: { label: "파일 컨텍스트 메뉴", scope: "files" },
} as const satisfies Record<string, { label: string; scope: Scope }>;
export type ShortcutAction = keyof typeof shortcutActions;
export const shortcutActionIds = Object.keys(shortcutActions) as [
  ShortcutAction,
  ...ShortcutAction[],
];
export type ShortcutMap = Record<ShortcutAction, string[]>;
export type ShortcutSettings = Record<ShortcutPlatform, ShortcutMap>;

const defaults = (platform: ShortcutPlatform): ShortcutMap => {
  const mod = platform === "darwin" ? "Meta" : "Ctrl";
  return {
    copy: [`${mod}+C`],
    paste: [`${mod}+V`],
    interrupt: [platform === "darwin" ? "Ctrl+C" : "Ctrl+Shift+C"],
    eof: ["Ctrl+D"],
    suspend: ["Ctrl+Z"],
    cliImage: [platform === "darwin" ? "Ctrl+V" : "Alt+V"],
    zoomIn: [`${mod}+Equal`],
    zoomOut: [`${mod}+Minus`],
    zoomReset: [`${mod}+0`],
    search: [`${mod}+Shift+F`],
    nextPane: ["Alt+ArrowRight"],
    previousPane: ["Alt+ArrowLeft"],
    newTab: [`${mod}+N`],
    newWindow: [`${mod}+Shift+N`],
    activity: [`${mod}+Shift+I`],
    recentActivity: [`${mod}+Shift+U`],
    fileSelectAll: [`${mod}+A`],
    fileRename: ["F2"],
    fileDelete: ["Delete"],
    fileMenu: ["Shift+F10"],
  };
};
export const defaultShortcuts: ShortcutSettings = {
  darwin: defaults("darwin"),
  win32: defaults("win32"),
};
export function shortcutPlatform(platform: string): ShortcutPlatform {
  if (platform === "darwin" || platform === "win32") return platform;
  throw new Error(`지원하지 않는 단축키 플랫폼: ${platform}`);
}
const modifiers = ["Ctrl", "Meta", "Alt", "Shift"];
const symbols: Record<string, string> = {
  "=": "Equal",
  "+": "Equal",
  "-": "Minus",
  _: "Minus",
  "[": "BracketLeft",
  "{": "BracketLeft",
  "]": "BracketRight",
  "}": "BracketRight",
  ";": "Semicolon",
  ":": "Semicolon",
  "'": "Quote",
  '"': "Quote",
  ",": "Comma",
  "<": "Comma",
  ".": "Period",
  ">": "Period",
  "/": "Slash",
  "?": "Slash",
  "\\": "Backslash",
  "|": "Backslash",
  "`": "Backquote",
  "~": "Backquote",
  " ": "Space",
};
const namedKeys = new Set([
  ...Object.values(symbols),
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Delete",
  "Backspace",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ContextMenu",
]);
export function normalizeShortcut(
  binding: string,
  platform: ShortcutPlatform,
): string {
  const parts = binding.trim().replace(/\+\+$/, "+Equal").split("+");
  let key = parts.pop() || "";
  key = symbols[key] || (/^[a-z0-9]$/i.test(key) ? key.toUpperCase() : key);
  const expanded = parts.flatMap((part) =>
    part === "Mod"
      ? [platform === "darwin" ? "Meta" : "Ctrl"]
      : part === "Platform"
        ? platform === "darwin"
          ? ["Meta"]
          : ["Ctrl", "Shift"]
        : [part],
  );
  const mods = modifiers.filter((mod) => expanded.includes(mod));
  if (
    expanded.some((mod) => !modifiers.includes(mod)) ||
    !(
      /^[A-Z0-9]$/.test(key) ||
      /^F(?:[1-9]|1\d|2[0-4])$/.test(key) ||
      namedKeys.has(key)
    ) ||
    (!mods.some((mod) => mod !== "Shift") &&
      !/^F\d+$/.test(key) &&
      !["Delete", "ContextMenu"].includes(key))
  )
    throw new Error(
      "문자 키에는 Ctrl·⌘·Alt 중 하나를 함께 누르세요. Esc·Tab·Enter·방향키만 누르는 화면 조작은 유지됩니다.",
    );
  return [...mods, key].join("+");
}
export type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "isComposing">>;
export function shortcutFromEvent(event: ShortcutEvent): string | undefined {
  if (
    event.isComposing ||
    [
      "Control",
      "Meta",
      "Alt",
      "Shift",
      "AltGraph",
      "Dead",
      "Process",
      "Unidentified",
    ].includes(event.key)
  )
    return;
  const code = event.code || "";
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit\d$/.test(code)
      ? code.slice(5)
      : namedKeys.has(code)
        ? code
        : symbols[event.key] || event.key;
  return [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Meta",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
export function shortcutMatch(
  event: ShortcutEvent,
  bindings: string | readonly string[],
  mac: boolean,
): boolean {
  const value = shortcutFromEvent(event);
  if (!value) return false;
  const platform = mac ? "darwin" : "win32";
  try {
    const normalized = normalizeShortcut(value, platform);
    return (typeof bindings === "string" ? [bindings] : bindings).some(
      (binding) =>
        binding && normalizeShortcut(binding, platform) === normalized,
    );
  } catch {
    return false;
  }
}
export function formatShortcut(
  binding: string,
  platform: ShortcutPlatform,
): string {
  const labels: Record<string, string> = {
    Meta: platform === "darwin" ? "⌘" : "Win",
    Alt: platform === "darwin" ? "⌥" : "Alt",
    Equal: "=",
    Minus: "−",
    ArrowRight: "→",
    ArrowLeft: "←",
    ArrowUp: "↑",
    ArrowDown: "↓",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Backquote: "`",
    Space: "Space",
  };
  return binding
    .split("+")
    .map((part) => labels[part] || part)
    .join(" + ");
}
function overlaps(a: ShortcutAction, b: ShortcutAction) {
  const sa = shortcutActions[a].scope,
    sb = shortcutActions[b].scope;
  return sa === "app" || sb === "app" || sa === sb;
}
export function validateShortcutMap(
  bindings: ShortcutMap,
  platform: ShortcutPlatform,
) {
  const seen: { action: ShortcutAction; key: string }[] = [];
  for (const action of shortcutActionIds) {
    if (bindings[action].length > 1)
      throw new Error(
        `${shortcutActions[action].label}: 단축키는 한 개만 지정할 수 있습니다.`,
      );
    for (const binding of bindings[action]) {
      const key = normalizeShortcut(binding, platform);
      const conflict = seen.find(
        (item) => item.key === key && overlaps(action, item.action),
      );
      if (conflict)
        throw new Error(
          `${platform === "darwin" ? "macOS" : "Windows"}: ${formatShortcut(key, platform)} — ${shortcutActions[conflict.action].label} / ${shortcutActions[action].label} 단축키가 중복됩니다.`,
        );
      seen.push({ action, key });
    }
  }
}
export function validateShortcuts(settings: ShortcutSettings) {
  for (const platform of ["darwin", "win32"] as const)
    validateShortcutMap(settings[platform], platform);
}
const legacyDefaults = {
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
export function migrateShortcuts(raw: unknown): unknown {
  if (raw === undefined) return structuredClone(defaultShortcuts);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if ("darwin" in raw || "win32" in raw) return raw;
  const legacy = raw as Record<string, unknown>;
  if (
    Object.entries(legacy).some(
      ([key, value]) => !(key in legacyDefaults) || typeof value !== "string",
    )
  )
    return raw;
  const result = {} as ShortcutSettings;
  for (const platform of ["darwin", "win32"] as const) {
    const lane = {} as ShortcutMap;
    const custom = new Set<ShortcutAction>();
    for (const [id, original] of Object.entries(legacy)) {
      const action = id as keyof typeof legacyDefaults;
      let value = original as string;
      // The old new-tab default predates the independent-window shortcut.
      if (
        action === "newTab" &&
        value === "Mod+Shift+T" &&
        !("newWindow" in legacy) &&
        !Object.entries(legacy).some(
          ([other, binding]) =>
            other !== action &&
            binding &&
            normalizeShortcut(binding as string, platform) ===
              normalizeShortcut("Mod+N", platform),
        )
      )
        value = "Mod+N";
      if (
        !value ||
        normalizeShortcut(value, platform) !==
          normalizeShortcut(legacyDefaults[action], platform)
      ) {
        lane[action] = value ? [normalizeShortcut(value, platform)] : [];
        custom.add(action);
      }
    }
    for (const action of shortcutActionIds) {
      if (custom.has(action)) continue;
      lane[action] = defaultShortcuts[platform][action]
        .filter(
          (binding) =>
            !Object.entries(lane).some(
              ([other, keys]) =>
                overlaps(action, other as ShortcutAction) &&
                keys.includes(normalizeShortcut(binding, platform)),
            ),
        )
        .map((binding) => normalizeShortcut(binding, platform));
    }
    result[platform] = lane;
  }
  return result;
}
export const shortcutSettingsSchema = z.preprocess(
  (raw, ctx) => {
    try {
      return migrateShortcuts(raw);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  },
  z
    .object({
      darwin: z.record(
        z.enum(shortcutActionIds),
        z.array(z.string().min(1).max(80)).max(16),
      ),
      win32: z.record(
        z.enum(shortcutActionIds),
        z.array(z.string().min(1).max(80)).max(16),
      ),
    })
    .transform((settings, ctx) => {
      try {
        // Zod has cloned and checked the old array shape. Keep its first binding
        // on load/import/save, including explicit removal, without mutating input.
        for (const platform of ["darwin", "win32"] as const)
          for (const action of shortcutActionIds)
            settings[platform][action] = settings[platform][action]
              .slice(0, 1)
              .map((binding) => normalizeShortcut(binding, platform));
        validateShortcuts(settings);
        return settings;
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    }),
);

// Native/xterm fallbacks are independent of editable defaults. In particular,
// former secondary defaults must stay suppressed after migration or removal.
const nativeTerminalKeys: Record<ShortcutPlatform, readonly string[]> = {
  darwin: [
    "Ctrl+C",
    "Ctrl+D",
    "Ctrl+Z",
    "Ctrl+V",
    "Meta+C",
    "Meta+V",
    "Meta+Equal",
    "Meta+Shift+Equal",
    "Meta+Minus",
    "Meta+0",
  ],
  win32: [
    "Ctrl+C",
    "Ctrl+D",
    "Ctrl+Z",
    "Ctrl+V",
    "Ctrl+Shift+C",
    "Ctrl+Shift+V",
    "Alt+V",
    "Ctrl+Equal",
    "Ctrl+Shift+Equal",
    "Ctrl+Minus",
    "Ctrl+0",
  ],
};

export function managedFileMenuKey(
  event: ShortcutEvent,
  platform: ShortcutPlatform,
) {
  return shortcutMatch(
    event,
    ["Shift+F10", "ContextMenu"],
    platform === "darwin",
  );
}

/** Old control bindings must not leak into xterm after reassignment or removal. */
export function managedTerminalKey(
  event: ShortcutEvent,
  platform: ShortcutPlatform,
) {
  return shortcutMatch(
    event,
    nativeTerminalKeys[platform],
    platform === "darwin",
  );
}

export type ShortcutContext =
  "standard" | "editing" | "terminal" | "files" | "dialog" | "recording";
/** Let renderer-owned keys reach the page before native menu accelerators. */
export function ignoreShortcutMenu(
  context: ShortcutContext,
  event: ShortcutEvent,
  settings: ShortcutSettings,
  platform: ShortcutPlatform,
) {
  if (context === "recording") return true;
  if (context === "dialog" || context === "editing") return false;
  const mac = platform === "darwin";
  if (context === "terminal" && managedTerminalKey(event, platform))
    return true;
  if (context === "files" && managedFileMenuKey(event, platform)) return true;
  return shortcutActionIds.some((id) => {
    const scope = shortcutActions[id].scope;
    if (scope !== "app" && scope !== context) return false;
    return (
      shortcutMatch(event, settings[platform][id], mac) ||
      (context === "files" &&
        scope === "files" &&
        shortcutMatch(event, defaultShortcuts[platform][id], mac))
    );
  });
}
