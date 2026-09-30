import type { Terminal, IDisposable, IMarker } from "@xterm/xterm";
import type { Appearance, CustomTheme } from "../shared/model";
import { getTheme } from "../shared/themes";
import { findHighlights } from "../shared/highlights";
type Paint = {
  x: number;
  width: number;
  foregroundColor?: string;
  backgroundColor?: string;
};
type Row = { marker: IMarker; signature: string; decorations: IDisposable[] };
export function highlightTerminal(
  term: Terminal,
  appearance: () => Appearance | undefined,
  custom: () => CustomTheme[],
) {
  let rows: Row[] = [],
    frame: number | undefined;
  const disposeRow = (row: Row) => {
    row.decorations.forEach((d) => d.dispose());
    row.marker.dispose();
  };
  const clear = () => {
    rows.forEach(disposeRow);
    rows = [];
  };
  const draw = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    const a = appearance();
    if (
      !a ||
      (a.highlight === "none" && !a.highlightAddresses && !a.highlightFiles) ||
      term.buffer.active.type === "alternate"
    ) {
      clear();
      return;
    }
    const palette = getTheme(a.theme, custom()).theme,
      buffer = term.buffer.active;
    const previous = new Map(
      rows.filter((r) => !r.marker.isDisposed).map((r) => [r.marker.line, r]),
    );
    const next: Row[] = [];
    const retained = new Set<Row>();
    for (
      let y = buffer.viewportY;
      y <
      Math.min(
        buffer.length,
        buffer.viewportY + term.rows,
        buffer.viewportY + 200,
      );
      y++
    ) {
      const line = buffer.getLine(y);
      if (!line) continue;
      // Most output has no highlighted spans. Avoid allocating cell maps for it.
      const tokens = findHighlights(
        line.translateToString(false),
        a.highlight,
        a.highlightAddresses,
        a.highlightFiles,
      );
      if (!tokens.length) continue;
      const columns: number[] = [],
        foreground: boolean[] = [],
        background: boolean[] = [];
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)!;
        foreground[x] = cell.isFgDefault();
        background[x] = cell.isBgDefault();
        if (cell.getWidth() === 0) continue;
        const value = cell.getChars() || " ";
        for (let n = 0; n < value.length; n++) columns.push(x);
      }
      const paints: Paint[] = [];
      const ranges = (
        left: number,
        right: number,
        allowed: boolean[],
        foregroundColor?: string,
        backgroundColor?: string,
      ) => {
        for (let x = left; x < right;) {
          if (!allowed[x]) {
            x++;
            continue;
          }
          const start = x;
          while (x < right && allowed[x]) x++;
          paints.push({
            x: start,
            width: x - start,
            foregroundColor,
            backgroundColor,
          });
        }
      };
      const level =
        tokens.find((t) => t.kind === "error") ||
        tokens.find((t) => t.kind === "warn");
      if (a.highlight === "line" && level) {
        const bg =
          (level.kind === "error" ? palette.red : palette.yellow) || "#ff7777";
        ranges(0, line.length, background, undefined, bg.slice(0, 7) + "25");
      }
      for (const token of tokens) {
        const color = {
          trace: palette.brightBlack,
          info: palette.green,
          warn: palette.yellow,
          error: palette.red,
          address: palette.cyan,
          directory: palette.blue,
          executable: palette.green,
          symlink: palette.cyan,
        }[token.kind];
        ranges(
          columns[token.start] ?? 0,
          columns[token.end] ??
            Math.min(
              line.length,
              (columns[token.end - 1] ?? 0) +
                Math.max(
                  1,
                  line.getCell(columns[token.end - 1] ?? 0)?.getWidth() ?? 1,
                ),
            ),
          foreground,
          color,
        );
      }
      if (!paints.length) continue;
      const signature = JSON.stringify(paints),
        old = previous.get(y);
      // Keep markers and decorations for unchanged color spans, even while other rows scroll.
      if (old?.signature === signature) {
        next.push(old);
        retained.add(old);
        continue;
      }
      const marker = term.registerMarker(y - (buffer.baseY + buffer.cursorY));
      if (!marker) continue;
      const decorations = paints.flatMap((p) => {
        const d = term.registerDecoration({ marker, ...p, layer: "bottom" });
        return d ? [d] : [];
      });
      next.push({ marker, signature, decorations });
    }
    for (const row of rows) if (!retained.has(row)) disposeRow(row);
    rows = next;
  };
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(draw);
  };
  // Parse callbacks run before the terminal's next paint: new lines never get a delayed recolor.
  const listeners = [
    term.onWriteParsed(draw),
    term.onScroll(schedule),
    term.onResize(schedule),
  ];
  return {
    refresh: draw,
    dispose() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      listeners.forEach((l) => l.dispose());
      clear();
    },
  };
}
