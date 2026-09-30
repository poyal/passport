import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { cloneWorkspaces } from "../shared/workspace-templates";
import {
  documentSchema,
  emptyDocument,
  hostSchema,
  secretSchema,
  profileUsernameSchema,
  type PassportDocument,
  type AuthProfile,
  type Secret,
} from "../shared/model";

export const packageSchema = z.object({
  format: z.literal("passport"),
  version: z.literal(1),
  document: documentSchema,
  profiles: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().max(256),
        type: z.enum(["password", "key"]),
        username: profileUsernameSchema.optional(),
      }),
    )
    .max(5000),
  secrets: z.record(z.string().uuid(), secretSchema).optional(),
});
export type Portable = z.infer<typeof packageSchema>;
const sealedSchema = z.object({
  format: z.literal("passport-encrypted"),
  version: z.literal(1),
  kdf: z.literal("scrypt"),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  nonce: z.string().regex(/^[a-f0-9]{24}$/),
  tag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z.string().max(24 * 1024 * 1024),
});
const derive = async (password: string, salt: Buffer) =>
  (await promisify(scrypt)(password, salt, 32)) as Buffer;
export function isEncryptedPortable(text: string): boolean {
  const value = safeJson(text);
  if ((value as { format?: string } | null)?.format !== "passport-encrypted")
    return false;
  sealedSchema.parse(value);
  return true;
}
export async function encodePortable(
  data: Portable,
  password?: string,
): Promise<string> {
  const valid = packageSchema.parse(data);
  if (!password) {
    const { secrets: _, ...publicData } = valid;
    return JSON.stringify(publicData, null, 2);
  }
  if (password.length < 10)
    throw new Error("내보내기 암호는 10자 이상이어야 합니다.");
  const salt = randomBytes(16),
    nonce = randomBytes(12),
    key = await derive(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("passport:1:scrypt"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(valid)),
      cipher.final(),
    ]);
    return JSON.stringify({
      format: "passport-encrypted",
      version: 1,
      kdf: "scrypt",
      salt: salt.toString("hex"),
      nonce: nonce.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("base64"),
    });
  } finally {
    key.fill(0);
  }
}
export function safeJson(text: string): unknown {
  if (Buffer.byteLength(text) > 24 * 1024 * 1024)
    throw new Error("파일 크기는 최대 24MB입니다.");
  const parsed: unknown = JSON.parse(text);
  const queue: [unknown, number][] = [[parsed, 0]];
  while (queue.length) {
    const [value, depth] = queue.pop()!;
    if (depth > 48) throw new Error("파일의 중첩 깊이가 너무 큽니다.");
    if (value && typeof value === "object")
      for (const child of Object.values(value)) queue.push([child, depth + 1]);
  }
  return parsed;
}
export async function decodePortable(
  text: string,
  password?: string,
): Promise<Portable> {
  let value = safeJson(text);
  if ((value as { format?: string })?.format === "passport-encrypted") {
    if (!password)
      throw new Error("암호화된 파일입니다. 가져오기 암호를 입력해 주세요.");
    const sealed = sealedSchema.parse(value),
      key = await derive(password, Buffer.from(sealed.salt, "hex"));
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(sealed.nonce, "hex"),
      );
      decipher.setAAD(Buffer.from("passport:1:scrypt"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
      value = safeJson(
        Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw new Error("암호가 다르거나 파일이 손상되었습니다.");
    } finally {
      key.fill(0);
    }
  }
  return packageSchema.parse(value);
}
export const hostIdentity = (h: {
  protocol: string;
  address: string;
  port: number;
  username: string;
}) => `${h.protocol}\0${h.address.toLowerCase()}\0${h.port}\0${h.username}`;
export function mergePortable(
  current: PassportDocument,
  profiles: AuthProfile[],
  incoming: Portable,
  conflict: "skip" | "overwrite",
): {
  document: PassportDocument;
  profiles: AuthProfile[];
  secrets: Record<string, Secret>;
} {
  const document = structuredClone(current),
    resultProfiles = structuredClone(profiles),
    hostMap = new Map<string, string>();
  function merge<T extends { id: string }>(list: T[], other: T[]) {
    for (const item of other) {
      const index = list.findIndex((x) => x.id === item.id);
      if (index < 0) list.push(item);
      else if (conflict === "overwrite") list[index] = item;
    }
  }
  merge(document.groups, incoming.document.groups);
  merge(document.snippets, incoming.document.snippets);
  merge(resultProfiles, incoming.profiles);
  const authIds = new Set(resultProfiles.map((p) => p.id));
  for (const item of incoming.document.hosts) {
    const existing = document.hosts.find(
      (h) => h.id === item.id || hostIdentity(h) === hostIdentity(item),
    );
    const h = {
      ...item,
      id: existing?.id ?? item.id,
      authId: item.authId && authIds.has(item.authId) ? item.authId : null,
      sftpAuthId:
        item.sftpAuthId && authIds.has(item.sftpAuthId)
          ? item.sftpAuthId
          : null,
    };
    hostMap.set(item.id, h.id);
    if (!existing) document.hosts.push(h);
    else if (conflict === "overwrite") Object.assign(existing, h);
  }
  // Imported layout IDs must not collide with other live layouts. Restored panes never connect automatically.
  for (const item of incoming.document.workspaces) {
    const existing = document.workspaces.findIndex((w) => w.id === item.id);
    if (existing >= 0 && conflict === "skip") continue;
    const w = structuredClone(item);
    const visit = (node: typeof w.root) => {
      node.id = randomUUID();
      if (node.kind === "pane")
        node.hostId = hostMap.get(node.hostId) ?? node.hostId;
      else node.children.forEach(visit);
    };
    visit(w.root);
    if (existing >= 0) document.workspaces[existing] = w;
    else document.workspaces.push(w);
  }
  for (const item of incoming.document.workspaceTemplates) {
    const existing = document.workspaceTemplates.findIndex(
      (t) => t.id === item.id,
    );
    if (existing >= 0 && conflict === "skip") continue;
    const template = {
      ...item,
      ...cloneWorkspaces(
        item.workspaces,
        item.activeWorkspaceId,
        item.activePaneId,
        randomUUID,
      ),
    };
    const remap = (node: (typeof template.workspaces)[number]["root"]) => {
      if (node.kind === "pane")
        node.hostId = hostMap.get(node.hostId) ?? node.hostId;
      else node.children.forEach(remap);
    };
    template.workspaces.forEach((w) => remap(w.root));
    if (existing >= 0) document.workspaceTemplates[existing] = template;
    else document.workspaceTemplates.push(template);
  }
  const customThemes = structuredClone(document.settings.customThemes);
  merge(customThemes, incoming.document.settings.customThemes);
  if (conflict === "overwrite") document.settings = incoming.document.settings;
  document.settings = { ...document.settings, customThemes };
  merge(
    document.tunnels,
    incoming.document.tunnels.map((t) => ({
      ...t,
      hostId: hostMap.get(t.hostId) ?? t.hostId,
    })),
  );
  const secrets: Record<string, Secret> = {};
  for (const [id, secret] of Object.entries(incoming.secrets ?? {}))
    if (conflict === "overwrite" || !profiles.some((p) => p.id === id))
      secrets[id] = secret;
  return {
    document: documentSchema.parse(document),
    profiles: resultProfiles,
    secrets,
  };
}
export function parseSSHConfig(text: string): {
  document: PassportDocument;
  warnings: string[];
} {
  const document = emptyDocument(),
    warnings: string[] = [];
  let aliases: string[] = [],
    fields: Record<string, string> = {};
  const flush = () => {
    for (const alias of aliases) {
      if (/[?*!%]/.test(alias)) {
        warnings.push(`${alias}: 패턴 호스트는 건너뛰었습니다.`);
        continue;
      }
      if (!fields.user) {
        warnings.push(`${alias}: User가 없어 가져오지 않았습니다.`);
        continue;
      }
      const parsed = hostSchema.safeParse({
        id: randomUUID(),
        name: alias,
        address: fields.hostname ?? alias,
        port: Number(fields.port ?? 22),
        username: fields.user,
      });
      if (parsed.success) document.hosts.push(parsed.data);
      else warnings.push(`${alias}: 주소·계정·포트를 확인해 주세요.`);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const tokens: string[] = [];
    let current = "",
      quote = "";
    for (const char of raw) {
      if (quote) {
        if (char === quote) quote = "";
        else current += char;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "#") break;
      else if (/\s|=/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else current += char;
    }
    if (current) tokens.push(current);
    if (quote) {
      warnings.push("닫히지 않은 인용부호가 있는 줄을 건너뛰었습니다.");
      continue;
    }
    if (!tokens?.length || raw.trimStart().startsWith("#")) continue;
    const key = tokens[0].toLowerCase(),
      value = tokens.slice(1).join(" ");
    if (key === "host") {
      flush();
      aliases = tokens.slice(1);
      fields = {};
    } else if (key === "match") {
      flush();
      aliases = [];
      fields = {};
      warnings.push("Match 블록은 지원하지 않습니다.");
    } else if (["hostname", "port", "user"].includes(key)) {
      if (!(key in fields)) fields[key] = value;
    } else
      warnings.push(
        `${tokens[0]}: 가져오지 않았습니다.${key === "identityfile" ? " 키 파일을 인증 프로필에서 다시 선택해 주세요." : ""}`,
      );
  }
  flush();
  return { document, warnings: [...new Set(warnings)] };
}
