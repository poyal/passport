import type { Terminal, IUnicodeVersionProvider } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { UnicodeWidth } from "../shared/terminal-config";

export function configureTerminalUnicode(
  term: Terminal,
  mode: UnicodeWidth = "unicode11",
) {
  const addon = new Unicode11Addon();
  // Compose the addon's provider through its public registration API. Keep its
  // tables and default provider intact; do not depend on xterm's private core.
  const unicode = new Proxy(term.unicode, {
    get(target, key) {
      if (key === "register")
        return (base: IUnicodeVersionProvider) => {
          target.register(base);
          target.register({
            version: "passport-macos-zsh",
            // Measured macOS zsh 5.9 prompt/ZLE widths (issue #8). This opt-in
            // terminal-wide policy also affects programs launched from that shell.
            wcwidth(codepoint) {
              if (codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff) return 2;
              if (
                (codepoint >= 0x1160 && codepoint <= 0x11ff) ||
                codepoint === 0x200d
              )
                return 1;
              return base.wcwidth(codepoint);
            },
            charProperties: base.charProperties,
          });
        };
      return Reflect.get(target, key, target);
    },
  });
  term.loadAddon({
    activate(terminal) {
      addon.activate(
        new Proxy(terminal, {
          get(target, key) {
            return key === "unicode"
              ? unicode
              : Reflect.get(target, key, target);
          },
        }),
      );
    },
    dispose() {
      addon.dispose();
    },
  });
  term.unicode.activeVersion = unicodeVersion(mode);
}

export function unicodeVersion(mode: UnicodeWidth) {
  return mode === "macos-zsh" ? "passport-macos-zsh" : "11";
}
