import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { configureTerminalUnicode, unicodeVersion } from "./terminal-unicode";
import type { UnicodeWidth } from "../shared/terminal-config";
import { highlightTerminal } from "./highlights";
import {
  shortcutMatch,
  managedTerminalKey,
  type ShortcutPlatform,
} from "../shared/shortcuts";
import type { PassportDocument, TerminalSnapshot } from "../shared/model";
import { SearchAddon } from "@xterm/addon-search";
import type { Appearance } from "../shared/model";
import { getTheme } from "../shared/themes";
import { api } from "./api";
import { availableFont, terminalFontFamily } from "../shared/fonts";
import { loadTerminalFont } from "./fonts";
import { PasteQueue } from "../shared/paste";
import { readControlText } from "../shared/terminal-control";
import { resumeScreenLimit, type ResumeScreen } from "../shared/session-resume";
type Entry = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  resize?: ResizeObserver;
  connected: boolean;
  connectionRevision: number;
  sessionInstanceId?: string;
  unicodeWidth: UnicodeWidth;
  pasteSessionInstanceId?: string;
  pasteQueue: PasteQueue;
  serialize: SerializeAddon;
  appearance?: Appearance;
  appearanceKey?: string;
  highlights?: ReturnType<typeof highlightTerminal>;
  backspace: "DEL" | "BS";
  physicalKey?: string;
  composing: boolean;
  pasting?: boolean;
  hydrating?: boolean;
  transferring?: boolean;
};
export const terminals = new Map<string, Entry>();
let settings: PassportDocument["settings"] | undefined;
let platform: ShortcutPlatform | undefined;
let installedFonts: string[] = [];
const warnedFonts = new Set<string>();
export function setTerminalFonts(fonts: string[]) {
  installedFonts = fonts;
}
let broadcast: string[] = [];
export function setBroadcast(ids: string[]) {
  broadcast = ids;
}
export function setTerminalSettings(
  value: PassportDocument["settings"],
  os: ShortcutPlatform,
) {
  settings = value;
  platform = os;
  for (const [id, e] of terminals)
    if (e.appearance) applyAppearance(id, e.appearance);
}
export function configurePane(id: string, backspace: "DEL" | "BS") {
  ensureTerminal(id).backspace = backspace;
}
let pasteHandler: (
  text: string,
  ids: string[],
  sessionInstanceId?: string,
) => void = () => {};
let errorHandler: (error: unknown) => void = () => {};
export type TerminalMenuRequest = {
  id: string;
  x: number;
  y: number;
  selection: string;
  canPaste: boolean;
  valid(): boolean;
  copy(): void;
  paste(): void;
  focus(): void;
};
let menuHandler: (request: TerminalMenuRequest) => void = () => {};
export function configureTerminals(
  paste: typeof pasteHandler,
  error: typeof errorHandler,
  menu: typeof menuHandler,
) {
  pasteHandler = paste;
  errorHandler = error;
  menuHandler = menu;
}
export function ensureTerminal(id: string) {
  const existing = terminals.get(id);
  if (existing) return existing;
  const term = new Terminal({
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 10000,
    allowProposedApi: true,
    theme: getTheme("mocha").theme,
    convertEol: false,
    linkHandler: {
      activate: (_event, url) => {
        void api.call("terminal.link", { id, url }).catch(errorHandler);
      },
    },
  });
  configureTerminalUnicode(term);
  const fit = new FitAddon(),
    search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  const element = document.createElement("div");
  element.className = "terminal-surface";
  const entry: Entry = {
    term,
    fit,
    search,
    serialize,
    element,
    connected: false,
    unicodeWidth: "unicode11",
    connectionRevision: 0,
    pasteQueue: new PasteQueue(),
    backspace: "DEL",
    composing: false,
  };
  entry.highlights = highlightTerminal(
    term,
    () => entry.appearance,
    () => settings?.customThemes || [],
  );
  terminals.set(id, entry);
  element.addEventListener(
    "compositionstart",
    () => {
      entry.composing = true;
    },
    true,
  );
  element.addEventListener(
    "compositionend",
    () => {
      setTimeout(() => {
        entry.composing = false;
      }, 0);
    },
    true,
  );
  term.onKey(({ key }) => {
    entry.physicalKey = key;
  });
  term.onData((data) => {
    if (!entry.connected || entry.hydrating) return;
    const physicalKey = entry.physicalKey === data;
    entry.physicalKey = undefined;
    if (entry.backspace === "BS" && data === "\x7f") data = "\b";
    // Only a physical key/composition can fan out. Device status reports and paste stay at their source.
    if (
      broadcast.includes(id) &&
      !entry.pasting &&
      (physicalKey || (entry.composing && !data.includes("\x1b"))) &&
      !data.startsWith("\x1b[200~")
    )
      void api
        .call("session.broadcast", { source: id, ids: broadcast, data })
        .catch(errorHandler);
    else
      void api
        .call("session.input", {
          id,
          data,
          sessionInstanceId: entry.pasteSessionInstanceId,
        })
        .catch(errorHandler);
  });
  term.onBinary((data) => {
    if (entry.connected && !entry.hydrating)
      void api
        .call("session.input", { id, data, binary: true })
        .catch(errorHandler);
  });
  term.onResize(({ cols, rows }) => {
    void api.call("session.resize", { id, cols, rows }).catch(errorHandler);
  });
  const readPaste = () => {
    if (!entry.connected || entry.hydrating) return;
    const revision = entry.connectionRevision;
    void entry.pasteQueue.enqueue(
      () => api.call("clipboard.terminal", { id }),
      () =>
        terminals.get(id) === entry &&
        entry.connected &&
        !entry.hydrating &&
        entry.connectionRevision === revision,
      (value) => {
        if (value.kind !== "empty") pasteHandler(value.text, [id]);
      },
      errorHandler,
    );
  };
  const openMenu = (x: number, y: number) => {
    const selection = term.getSelection();
    const revision = entry.connectionRevision;
    menuHandler({
      id,
      x,
      y,
      selection,
      canPaste: entry.connected && !entry.hydrating && !entry.transferring,
      valid: () =>
        terminals.get(id) === entry &&
        !entry.transferring &&
        entry.connectionRevision === revision &&
        element.isConnected &&
        element.getClientRects().length > 0,
      copy: () => {
        if (selection)
          void api
            .call("clipboard.write", { text: selection })
            .catch(errorHandler);
      },
      paste: readPaste,
      focus: () => term.focus(),
    });
  };
  let suppressNativePaste = false;
  term.attachCustomKeyEventHandler((event) => {
    if (
      !settings ||
      !platform ||
      event.isComposing ||
      entry.composing ||
      event.keyCode === 229
    )
      return true;
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown" && !event.repeat) {
        const rect = element.getBoundingClientRect();
        openMenu(rect.left + 16, rect.top + 16);
      }
      return false;
    }
    const mac = platform === "darwin";
    const keys = settings.shortcuts[platform];
    const action = (
      [
        "copy",
        "paste",
        "interrupt",
        "eof",
        "suspend",
        "cliImage",
        "newline",
      ] as const
    ).find((action) => shortcutMatch(event, keys[action], mac));
    if (action || managedTerminalKey(event, platform)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== "keydown" || event.repeat) return false;
      if (action === "copy" && term.hasSelection()) {
        void api
          .call("clipboard.write", { text: term.getSelection() })
          .catch(errorHandler);
      } else if (action === "paste") {
        suppressNativePaste = true;
        setTimeout(() => {
          suppressNativePaste = false;
        }, 0);
        readPaste();
      } else if (
        action &&
        action !== "copy" &&
        entry.connected &&
        !entry.hydrating
      ) {
        const data = {
          interrupt: "\x03",
          eof: "\x04",
          suspend: "\x1a",
          cliImage: mac ? "\x16" : "\x1bv",
          newline: "\x1b[13;2u",
        }[action];
        // Control actions and CLI image input belong to this pane, even during broadcast.
        void api.call("session.input", { id, data }).catch(errorHandler);
      }
      return false;
    }
    return true;
  });
  element.addEventListener(
    "paste",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!suppressNativePaste) readPaste();
    },
    true,
  );
  // Preserve a selection while opening the menu, and keep its click out of
  // applications using terminal mouse reporting. Shift explicitly opens our menu.
  const appMenu = (event: MouseEvent) =>
    term.hasSelection() ||
    event.shiftKey ||
    term.modes.mouseTrackingMode === "none";
  element.addEventListener(
    "mousedown",
    (event) => {
      if (event.button === 2 && appMenu(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  element.addEventListener(
    "mouseup",
    (event) => {
      if (event.button === 2 && appMenu(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  element.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      if (!appMenu(event)) return;
      event.stopImmediatePropagation();
      // Keyboard requests were already handled above; Chromium may emit this too.
      if (event.button !== 2 && event.clientX === 0 && event.clientY === 0)
        return;
      openMenu(event.clientX, event.clientY);
    },
    true,
  );
  return entry;
}

export function dropTerminalFiles(id: string, files: File[]) {
  const entry = terminals.get(id);
  if (
    !entry?.connected ||
    entry.hydrating ||
    entry.transferring ||
    !entry.sessionInstanceId
  ) {
    errorHandler(new Error("로컬 터미널에 연결한 뒤 파일·폴더를 드롭하세요."));
    return;
  }
  const revision = entry.connectionRevision;
  const sessionInstanceId = entry.sessionInstanceId;
  // Resolve the File objects synchronously in preload before the drop event ends.
  const prepared = api.prepareTerminalDrop({ id, files, sessionInstanceId });
  void entry.pasteQueue.enqueue(
    () => prepared,
    () =>
      terminals.get(id) === entry &&
      entry.connected &&
      !entry.hydrating &&
      !entry.transferring &&
      entry.connectionRevision === revision &&
      entry.sessionInstanceId === sessionInstanceId &&
      entry.element.isConnected,
    (value) => pasteHandler(value.text, [id], value.sessionInstanceId),
    errorHandler,
  );
}
export function setTerminalTransfer(ids: string[], active: boolean) {
  for (const id of ids) {
    const entry = terminals.get(id);
    if (entry) {
      entry.transferring = active;
      entry.connectionRevision++;
    }
  }
  window.dispatchEvent(
    new CustomEvent("passport-terminal-transfer", { detail: { ids, active } }),
  );
}
export function attachTerminal(
  id: string,
  container: HTMLElement,
  appearance: Appearance,
) {
  const entry = ensureTerminal(id);
  container.append(entry.element);
  if (!entry.term.element) entry.term.open(entry.element);
  applyAppearance(id, appearance);
  entry.resize?.disconnect();
  const fit = () => {
    if (
      terminals.get(id) === entry &&
      entry.element.parentElement === container &&
      container.isConnected &&
      container.clientWidth > 50 &&
      container.clientHeight > 50
    ) {
      entry.fit.fit();
    }
  };
  entry.resize = new ResizeObserver(fit);
  const observer = entry.resize;
  observer.observe(container);
  const frame = requestAnimationFrame(fit);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    if (entry.element.parentElement === container) entry.element.remove();
  };
}
export function applyAppearance(id: string, a: Appearance) {
  const e = terminals.get(id);
  if (!e) return;
  const theme = getTheme(a.theme, settings?.customThemes).theme;
  const family = availableFont(a.font, installedFonts);
  const appearanceKey = JSON.stringify([a, theme, family]);
  e.appearance = a;
  if (e.appearanceKey === appearanceKey) return;
  e.appearanceKey = appearanceKey;
  e.term.options.theme = theme;
  e.term.options.lineHeight = a.lineHeight;
  e.term.options.letterSpacing = a.letterSpacing;
  e.term.options.fontWeight = a.fontWeight;
  e.term.options.cursorStyle = a.cursorStyle;
  e.term.options.cursorBlink = a.cursorBlink;
  e.highlights?.refresh();
  if (
    family.toLowerCase() !== a.font.toLowerCase() &&
    !warnedFonts.has(a.font)
  ) {
    warnedFonts.add(a.font);
    errorHandler(`설치되지 않은 글꼴 ${a.font} 대신 ${family}를 사용합니다.`);
  }
  const applyFont = (loadedFamily: string) => {
    if (terminals.get(id) !== e || e.appearanceKey !== appearanceKey) return;
    e.term.options.fontFamily = terminalFontFamily(loadedFamily);
    e.term.options.fontSize = a.fontSize;
    if (e.element.clientWidth > 50 && e.element.clientHeight > 50) e.fit.fit();
    e.term.refresh(0, e.term.rows - 1);
  };
  void loadTerminalFont(family, a.fontWeight === "bold")
    .then(() => applyFont(family))
    .catch(() => {
      applyFont("JetBrains Mono");
      if (!warnedFonts.has(family)) {
        warnedFonts.add(family);
        errorHandler(
          new Error(`${family} 글꼴을 불러오지 못해 기본 글꼴을 사용합니다.`),
        );
      }
    });
}
export function disposeMissing(ids: Set<string>) {
  for (const [id, e] of terminals) {
    if (!ids.has(id)) {
      e.resize?.disconnect();
      e.highlights?.dispose();
      e.term.dispose();
      e.element.remove();
      terminals.delete(id);
    }
  }
}

export async function inspectControlTerminal(
  request: import("../shared/terminal-control").ControlInspectionRequest,
): Promise<import("../shared/terminal-control").ControlInspection> {
  const entry = terminals.get(request.paneId);
  const base = {
    requestId: request.requestId,
    paneId: request.paneId,
    sessionId: request.sessionId,
  };
  if (!entry) return { ...base, error: "NOT_READY" };
  await new Promise<void>((resolve) => entry.term.write("", resolve));
  if (
    terminals.get(request.paneId) !== entry ||
    (entry.sessionInstanceId ?? null) !== request.sessionId
  )
    return { ...base, error: "SESSION_CHANGED" };
  if (entry.hydrating || entry.transferring)
    return { ...base, error: "MOVING" };
  const buffer = entry.term.buffer.active;
  return {
    ...base,
    bracketedPaste: entry.term.modes.bracketedPasteMode,
    backspace: entry.backspace,
    ...(request.lines !== undefined
      ? { ...readControlText(buffer, request.lines), buffer: buffer.type }
      : {}),
  };
}

export async function serializeTerminals(
  ids: string[],
  _appearance?: unknown,
): Promise<TerminalSnapshot[]> {
  return Promise.all(
    ids.map(
      (id) =>
        new Promise<TerminalSnapshot>((resolve) => {
          const e = ensureTerminal(id);
          e.term.write("", () =>
            resolve({
              id,
              sessionInstanceId: e.sessionInstanceId,
              data: e.serialize.serialize({ scrollback: 10000 }),
              cols: e.term.cols,
              rows: e.term.rows,
              appearance: e.appearance,
              unicodeWidth: e.unicodeWidth,
            }),
          );
        }),
    ),
  );
}
export function hydrateTerminals(snapshots: TerminalSnapshot[]) {
  for (const s of snapshots) {
    const e = ensureTerminal(s.id);
    e.connected = false;
    e.sessionInstanceId = s.sessionInstanceId;
    e.term.resize(s.cols, s.rows);
    e.term.reset();
    setTerminalUnicode(s.id, s.unicodeWidth ?? "unicode11");
    e.hydrating = true;
    e.term.write(s.data, () => {
      e.hydrating = false;
    });
  }
}

export async function checkpointTerminal(
  id: string,
): Promise<ResumeScreen | undefined> {
  const e = terminals.get(id);
  if (!e || e.hydrating || e.transferring) return;
  await new Promise<void>((resolve) => e.term.write("", resolve));
  if (terminals.get(id) !== e || e.hydrating || e.transferring) return;
  const serialize = (lines: number) =>
    e.serialize.serialize({
      scrollback: lines,
      excludeAltBuffer: true,
      excludeModes: true,
    });
  let lines = 10000,
    data = serialize(lines);
  while (
    new TextEncoder().encode(data).length > resumeScreenLimit &&
    lines > 0
  ) {
    lines = Math.floor(lines / 2);
    data = serialize(lines);
  }
  if (new TextEncoder().encode(data).length > resumeScreenLimit) data = "";
  return {
    id,
    data,
    cols: e.term.cols,
    rows: e.term.rows,
    unicodeWidth: e.unicodeWidth,
  };
}

export async function restoreTerminal(
  screen: ResumeScreen,
  cancelled: () => boolean,
) {
  const e = ensureTerminal(screen.id);
  await new Promise<void>((resolve) => e.term.write("", resolve));
  if (cancelled() || terminals.get(screen.id) !== e || e.transferring) return;
  e.connected = false;
  e.hydrating = true;
  const { cols, rows } = e.term;
  e.term.reset();
  setTerminalUnicode(screen.id, screen.unicodeWidth ?? "unicode11");
  e.term.resize(screen.cols, screen.rows);
  await new Promise<void>((resolve) =>
    e.term.write(
      screen.data + "\x1b[0m\r\n── 이전 세션 출력 · 새 연결 ──\r\n",
      resolve,
    ),
  );
  if (terminals.get(screen.id) === e) {
    e.term.resize(cols, rows);
    e.hydrating = false;
  }
}

export function setTerminalUnicode(id: string, mode: UnicodeWidth) {
  const entry = ensureTerminal(id);
  if (entry.unicodeWidth === mode) return;
  // A new width policy cannot safely reuse scrollback parsed with the old one.
  entry.term.reset();
  entry.term.unicode.activeVersion = unicodeVersion(mode);
  entry.unicodeWidth = mode;
}
