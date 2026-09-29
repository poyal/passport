import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { highlightTerminal } from "./highlights";
import { shortcutMatch } from "../shared/advanced";
import type { PassportDocument, TerminalSnapshot } from "../shared/model";
import { SearchAddon } from "@xterm/addon-search";
import type { Appearance } from "../shared/model";
import { getTheme } from "../shared/themes";
import { api } from "./api";
type Entry = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  resize?: ResizeObserver;
  connected: boolean;
  serialize: SerializeAddon;
  appearance?: Appearance;
  appearanceKey?: string;
  highlights?: ReturnType<typeof highlightTerminal>;
  backspace: "DEL" | "BS";
  physicalKey?: string;
  composing: boolean;
  hydrating?: boolean;
};
export const terminals = new Map<string, Entry>();
let settings: PassportDocument["settings"] | undefined;
let broadcast: string[] = [];
export function setBroadcast(ids: string[]) {
  broadcast = ids;
}
export function setTerminalSettings(value: PassportDocument["settings"]) {
  settings = value;
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
  element.addEventListener(
    "keydown",
    (event) => {
      entry.physicalKey = event.key;
      setTimeout(() => {
        entry.physicalKey = undefined;
      }, 0);
    },
    true,
  );
  term.onData((data) => {
    if (!entry.connected || entry.hydrating) return;
    if (entry.backspace === "BS" && data === "\x7f") data = "\b";
    // Only a physical key/composition can fan out. Device status reports and paste stay at their source.
    if (
      broadcast.includes(id) &&
      (entry.physicalKey || entry.composing) &&
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
  term.attachCustomKeyEventHandler((event) => {
    const mac = navigator.platform.includes("Mac");
    const copy = shortcutMatch(
      event,
      settings?.shortcuts.copy || "Platform+C",
      mac,
    );
    const paste = shortcutMatch(
      event,
      settings?.shortcuts.paste || "Platform+V",
      mac,
    );
    if (copy) {
      if (event.type === "keydown") {
        void api
          .call("clipboard.write", { text: term.getSelection() })
          .catch(errorHandler);
      }
      return false;
    }
    if (paste) {
      if (event.type === "keydown")
        void api
          .call("clipboard.read", undefined)
          .then((text) => pasteHandler(text, [id]))
          .catch(errorHandler);
      return false;
    }
    // Browser Ctrl+V must not bypass the paste preview on Windows.
    if (event.ctrlKey && event.code === "KeyV") return false;
    return true;
  });
  element.addEventListener(
    "paste",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text/plain");
      if (text !== undefined) pasteHandler(text, [id]);
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
    if (container.clientWidth > 50 && container.clientHeight > 50) {
      entry.fit.fit();
    }
  };
  entry.resize = new ResizeObserver(fit);
  const observer = entry.resize;
  observer.observe(container);
  requestAnimationFrame(fit);
  return () => {
    observer.disconnect();
    if (entry.element.parentElement === container) entry.element.remove();
  };
}
export function applyAppearance(id: string, a: Appearance) {
  const e = terminals.get(id);
  if (!e) return;
  const theme = getTheme(a.theme, settings?.customThemes).theme;
  const appearanceKey = JSON.stringify([a, theme]);
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
  e.term.options.fontFamily = `"${a.font.replace(/["\\]/g, "")}", "JetBrains Mono", monospace`;
  e.term.options.fontSize = a.fontSize;
  if (e.element.clientWidth > 50 && e.element.clientHeight > 50) e.fit.fit();
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
