export type Highlight = {
  start: number;
  end: number;
  kind:
    | "trace"
    | "info"
    | "warn"
    | "error"
    | "address"
    | "directory"
    | "executable"
    | "symlink";
};
// Only classify long listings with permissions and metadata. A filename or
// extension alone cannot establish whether a file is executable or a directory.
const listing =
  /^\s*([bcdlps-][r-][w-][xSs-][r-][w-][xSs-][r-][w-][xTt-][.+@]?)\s+\d+\s+\S+\s+\S+\s+\d+\s+(?:\S+\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s+[+-]\d{4})?)\s+(.+?)\s*$/;
export function findFileHighlight(text: string): Highlight | undefined {
  const match = listing.exec(text);
  if (!match) return;
  const permissions = match[1];
  const kind =
    permissions[0] === "d"
      ? "directory"
      : permissions[0] === "l"
        ? "symlink"
        : permissions[0] === "-" &&
            [3, 6, 9].some((i) => /[xst]/.test(permissions[i]))
          ? "executable"
          : undefined;
  if (!kind) return;
  const name = match[2];
  const nameStart =
    match[0].length -
    (match[0].length - match[0].trimEnd().length) -
    name.length;
  const arrow = kind === "symlink" ? name.indexOf(" -> ") : -1;
  return {
    start: nameStart,
    end: nameStart + (arrow < 0 ? name.length : arrow),
    kind,
  };
}
export function findHighlights(
  text: string,
  mode: "none" | "log" | "line" | "address",
  addresses = false,
  files = false,
): Highlight[] {
  const result: Highlight[] = [];
  if (mode === "log" || mode === "line")
    for (const m of text.matchAll(
      /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/g,
    )) {
      const before = text[m.index! - 1],
        after = text[m.index! + m[0].length];
      if (
        (before && !/[\s[(|]/.test(before)) ||
        (after && !/[\s\]):|]/.test(after))
      )
        continue;
      result.push({
        start: m.index!,
        end: m.index! + m[0].length,
        kind: /ERROR|FATAL/.test(m[0])
          ? "error"
          : /^WARN/.test(m[0])
            ? "warn"
            : m[0] === "INFO"
              ? "info"
              : "trace",
      });
    }
  if (mode === "address" || addresses) {
    for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      let value = m[0].replace(/[.,;)]+$/, "");
      try {
        new URL(value);
        result.push({
          start: m.index!,
          end: m.index! + value.length,
          kind: "address",
        });
      } catch {}
    }
    for (const m of text.matchAll(/(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/g)) {
      if (
        /[\w.]/.test(text[m.index! - 1] || "") ||
        /[\w.]/.test(text[m.index! + m[0].length] || "")
      )
        continue;
      const [ip, port] = m[0].split(":");
      if (
        ip.split(".").some((p) => Number(p) > 255) ||
        (port && Number(port) > 65535)
      )
        continue;
      result.push({
        start: m.index!,
        end: m.index! + m[0].length,
        kind: "address",
      });
    }
    for (const m of text.matchAll(
      /\[?[0-9a-fA-F]*:[0-9a-fA-F:]+\]?(?::\d{1,5})?/g,
    )) {
      const raw = m[0],
        ip = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw;
      if (
        (ip.match(/:/g) || []).length < 2 ||
        /[\w:]/.test(text[m.index! - 1] || "") ||
        /[\w:]/.test(text[m.index! + raw.length] || "")
      )
        continue;
      try {
        new URL(`http://[${ip}]/`);
        result.push({
          start: m.index!,
          end: m.index! + raw.length,
          kind: "address",
        });
      } catch {}
    }
  }
  const file = files ? findFileHighlight(text) : undefined;
  return (
    file
      ? [
          file,
          ...result.filter(
            (token) => token.end <= file.start || token.start >= file.end,
          ),
        ]
      : result
  ).slice(0, 100);
}
