import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
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
type Entry = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  resize?: ResizeObserver;
  connected: boolean;
  connectionRevision: number;
  serialize: SerializeAddon;
  appearance?: Appearance;
  appearanceKey?: string;
  highlights?: ReturnType<typeof highlightTerminal>;
  backspace: "DEL" | "BS";
  physicalKey?: string;
  composing: boolean;
  pasting?: boolean;
  hydrating?: boolean;
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
let pasteHandler: (text: string, ids: string[]) => void = () => {};
let errorHandler: (error: unknown) => void = () => {};
export function configureTerminals(
  paste: typeof pasteHandler,
  error: typeof errorHandler,
) {
  pasteHandler = paste;
  errorHandler = error;
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
    connectionRevision: 0,
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
    else void api.call("session.input", { id, data }).catch(errorHandler);
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
  const pasteQueue = new PasteQueue();
  const readPaste = () => {
    if (!entry.connected || entry.hydrating) return;
    const revision = entry.connectionRevision;
    void pasteQueue.enqueue(
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
  let suppressNativePaste = false;
  term.attachCustomKeyEventHandler((event) => {
    if (!settings || !platform || event.isComposing) return true;
    const mac = platform === "darwin";
    const keys = settings.shortcuts[platform];
    const action = (
      ["copy", "paste", "interrupt", "eof", "suspend", "cliImage"] as const
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
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (term.hasSelection())
      void api
        .call("clipboard.write", { text: term.getSelection() })
        .catch(errorHandler);
  });
  return entry;
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
              data: e.serialize.serialize({ scrollback: 10000 }),
              cols: e.term.cols,
              rows: e.term.rows,
              appearance: e.appearance,
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
    e.term.resize(s.cols, s.rows);
    e.term.reset();
    e.hydrating = true;
    e.term.write(s.data, () => {
      e.hydrating = false;
    });
  }
}
