import {
  hostSchema,
  type Host,
  type Pane,
  type PassportDocument,
  type Appearance,
  type AuthProfile,
} from "./model";
export const LOCAL_HOST_ID = "00000000-0000-4000-8000-000000000001";
export function resolveHostSettings(
  document: PassportDocument,
  host: Host,
): Host {
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
  return next;
}
export function effectiveHost(document: PassportDocument, host: Host): Host {
  return hostSchema.parse(resolveHostSettings(document, host));
}
export function connectionHost(
  document: PassportDocument,
  host: Host,
  profiles: AuthProfile[],
  sftp = false,
): Host {
  const resolved = resolveHostSettings(document, host);
  const fileAccount =
    sftp && (resolved.protocol === "ssh" || resolved.protocol === "sftp");
  const profile = profiles.find(
    (p) =>
      p.id ===
      (fileAccount
        ? (resolved.sftpAuthId ?? resolved.authId)
        : resolved.authId),
  );
  if (profile?.username) {
    if (fileAccount) resolved.sftpUsername = profile.username;
    else resolved.username = profile.username;
  }
  return resolved;
}
export function paneHost(
  document: PassportDocument,
  pane: Pane,
  profiles: AuthProfile[] = [],
): Host {
  if (pane.local)
    return hostSchema.parse({
      id: LOCAL_HOST_ID,
      name: "로컬 터미널",
      address: "localhost",
      username: pane.local.shell,
    });
  const host = document.hosts.find((x) => x.id === pane.hostId);
  if (!host) throw new Error("호스트를 찾을 수 없습니다.");
  return hostSchema.parse(connectionHost(document, host, profiles));
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
export { shortcutMatch, validateShortcuts } from "./shortcuts";
