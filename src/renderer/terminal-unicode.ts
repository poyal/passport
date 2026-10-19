import type { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

export function configureTerminalUnicode(term: Terminal) {
  // Use Unicode 11 emoji cell widths before parsing live output or snapshots
  // restored when a pane moves to another window.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
}
