import {
  hostSchema,
  type Host,
  type Pane,
  type PassportDocument,
  type Appearance,
} from "./model";
export const LOCAL_HOST_ID = "00000000-0000-4000-8000-000000000001";
export function effectiveHost(document: PassportDocument, host: Host): Host {
  const ancestors = [];
  let id = host.groupId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const g = document.groups.find((x) => x.id === id);
    if (!g) break;
    ancestors.unshift(g);
    id = g.parentId;
  }
  const defaults: Record<string, unknown> = {};
  let appearance: Partial<Appearance> = {};
  for (const g of ancestors) {
    Object.assign(defaults, g.defaults);
    appearance = { ...appearance, ...g.defaults.appearance };
  }
  const next = { ...host, appearance: { ...appearance, ...host.appearance } };
  for (const field of host.inherit)
    if (defaults[field] !== undefined)
      Object.assign(next, { [field]: defaults[field] });
  return hostSchema.parse(next);
}
export function paneHost(document: PassportDocument, pane: Pane): Host {
  if (pane.local)
    return hostSchema.parse({
      id: LOCAL_HOST_ID,
      name: "로컬 터미널",
      address: "localhost",
      username: pane.local.shell,
    });
  const host = document.hosts.find((x) => x.id === pane.hostId);
  if (!host) throw new Error("호스트를 찾을 수 없습니다.");
  return effectiveHost(document, host);
}
export function variables(text: string) {
  return [
    ...new Set(
      [...text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
        (m) => m[1],
      ),
    ),
  ];
}
export function interpolate(text: string, values: Record<string, string>) {
  return text.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_, name: string) => {
      if (!Object.hasOwn(values, name))
        throw new Error(`변수 ${name}의 값을 입력해 주세요.`);
      return values[name];
    },
  );
}
export function executableCommand(text: string) {
  const clean = text.replace(/[\r\n]+$/, "");
  if (!clean.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean))
    throw new Error("빈 명령이나 제어 문자는 실행할 수 없습니다.");
  if (clean.length > 65536) throw new Error("명령이 너무 깁니다.");
  return clean;
}
export function shortcutMatch(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  binding: string,
  mac: boolean,
) {
  const parts = binding.split("+");
  const key = parts.pop()?.toLowerCase();
  const modifiers = new Set(
    parts.flatMap((x) =>
      x === "Platform"
        ? mac
          ? ["Meta"]
          : ["Ctrl", "Shift"]
        : [x === "Mod" ? (mac ? "Meta" : "Ctrl") : x],
    ),
  );
  return (
    e.key.toLowerCase() === key &&
    e.ctrlKey === modifiers.has("Ctrl") &&
    e.metaKey === modifiers.has("Meta") &&
    e.altKey === modifiers.has("Alt") &&
    e.shiftKey === modifiers.has("Shift")
  );
}
export function validateShortcuts(bindings: Record<string, string>) {
  for (const mac of [false, true]) {
    const seen = new Set<string>();
    for (const binding of Object.values(bindings)) {
      const pieces = binding.split("+");
      const key = pieces.pop();
      if (
        !key ||
        !/^(?:[A-Za-z0-9]|Arrow(?:Left|Right|Up|Down)|F(?:[1-9]|1[0-2]))$/.test(
          key,
        ) ||
        !pieces.length ||
        pieces.some(
          (x) =>
            !["Mod", "Platform", "Ctrl", "Meta", "Alt", "Shift"].includes(x),
        )
      )
        throw new Error("단축키는 Mod+Shift+T 같은 형식으로 입력하세요.");
      const modifiers = [
        ...new Set(
          pieces.flatMap((x) =>
            x === "Platform"
              ? mac
                ? ["Meta"]
                : ["Ctrl", "Shift"]
              : [x === "Mod" ? (mac ? "Meta" : "Ctrl") : x],
          ),
        ),
      ].sort();
      const normalized = modifiers.join("+") + "+" + key.toLowerCase();
      if (["Ctrl+c", "Ctrl+d", "Ctrl+z"].includes(normalized))
        throw new Error("Ctrl+C/D/Z는 터미널에서 사용합니다.");
      if (seen.has(normalized)) throw new Error("단축키가 중복됩니다.");
      seen.add(normalized);
    }
  }
}
