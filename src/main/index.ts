import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  nativeTheme,
  session,
  clipboard,
  protocol,
  net,
  Menu,
} from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { getFonts } from "font-list";
import { z } from "zod";
import {
  documentSchema,
  idSchema,
  secretSchema,
  snippetSchema,
  emptyDocument,
  type AppEvent,
  type Bootstrap,
  type Calls,
  type Call,
  type ImportPreview,
  type Secret,
  appearanceOverridesSchema,
  customThemeSchema,
  type TerminalSnapshot,
  type SessionState,
} from "../shared/model";
import { Store } from "./store";
import { Sessions, type TrustPrompt } from "./ssh";
import { Files } from "./files";
import { Transfers } from "./transfers";
import {
  decodePortable,
  encodePortable,
  mergePortable,
  parseSSHConfig,
  hostIdentity,
  safeJson,
  type Portable,
} from "./portable";
import { LocalSessions, availableShells } from "./local";
import { SessionLogs } from "./logs";
import { Tunnels } from "./tunnels";
import {
  effectiveHost,
  connectionHost,
  executableCommand,
  validateShortcuts,
} from "../shared/advanced";
import { panes } from "../shared/layout";

app.setName("Passport");
if (process.env.PASSPORT_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.PASSPORT_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "passport",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let window: BrowserWindow | undefined,
  store: Store,
  sessions: Sessions,
  files: Files,
  transfers: Transfers,
  backupTimer: ReturnType<typeof setInterval>,
  logPruneTimer: ReturnType<typeof setInterval>;
const previews = new Map<
  string,
  { data: Portable; warnings: string[]; kind: ImportPreview["kind"] }
>();
let fonts: string[] = [];
let locals: LocalSessions, logs: SessionLogs, tunnels: Tunnels;
const windows = new Map<number, BrowserWindow>();
const owners = new Map<string, number>();
const states = new Map<string, SessionState>();
const endpointOwners = new Map<string, number>();
const moves = new Map<
  string,
  {
    token: string;
    source: number;
    target: number;
    events: AppEvent[];
    timer: ReturnType<typeof setTimeout>;
  }
>();
const ownerRecord = () => Object.fromEntries(owners);
let documentCache: ReturnType<Store["read"]> | undefined;
const workspaceFor = (id: string) =>
  (documentCache ??= store.read()).workspaces.find((w) =>
    panes(w.root).some((p) => p.id === id),
  );
const ownerOf = (id: string) => owners.get(workspaceFor(id)?.id || "");
function publishDocument() {
  const document = store.read();
  documentCache = document;
  for (const id of owners.keys())
    if (!document.workspaces.some((w) => w.id === id)) owners.delete(id);
  for (const w of windows.values())
    if (!w.isDestroyed())
      w.webContents.send("passport:event", {
        kind: "document",
        profiles: store.profiles(),
        document,
        workspaceOwners: ownerRecord(),
      } satisfies AppEvent);
}
function closeSession(id: string) {
  logs?.stop(id);
  sessions.close(id);
  locals.close(id);
  states.delete(id);
}
function assertOwned(id: string, caller: BrowserWindow) {
  if (ownerOf(id) !== caller.id)
    throw new Error("이 창에 속한 터미널이 아닙니다.");
}

function sessionLogName(id: string) {
  const workspace = workspaceFor(id);
  const pane = workspace && panes(workspace.root).find((p) => p.id === id);
  const host = (documentCache ??= store.read()).hosts.find(
    (h) => h.id === pane?.hostId,
  );
  return host
    ? `${host.name} · ${connectionHost(documentCache!, host, store.profiles()).username}@${host.address}`
    : workspace?.name || "로컬 터미널";
}
let quitting = false;
let shutdown: Promise<void> | undefined;
let shutdownComplete = false;
const emit = (event: AppEvent, replay = false) => {
  if (shutdown) return;
  if (event.kind === "session") {
    states.set(event.state.id, event.state);
    if (event.state.status === "connected" && store.read().settings.autoLog) {
      try {
        logs.start(event.state.id, sessionLogName(event.state.id));
      } catch (error) {
        emit({
          kind: "notice",
          message: `세션 로그를 기록하지 못했습니다: ${error instanceof Error ? error.message : "저장 오류"}`,
        });
      }
    } else if (event.state.status === "disconnected")
      logs?.stop(event.state.id);
  }
  if (event.kind === "output" && !replay) logs?.append(event.id, event.data);
  if (event.kind === "output" || event.kind === "session") {
    const id = event.kind === "output" ? event.id : event.state.id;
    const workspace = workspaceFor(id);
    const moving = workspace && moves.get(workspace.id);
    if (moving) {
      moving.events.push(event);
      return;
    }
    const destination = windows.get(ownerOf(id) ?? -1);
    if (destination && !destination.isDestroyed())
      destination.webContents.send("passport:event", event);
    else if (event.kind === "output") {
      sessions.ack(id, event.bytes);
      locals.ack(id, event.bytes);
    }
  } else
    for (const w of windows.values())
      if (!w.isDestroyed()) w.webContents.send("passport:event", event);
};
const confirm: TrustPrompt = async (host, fingerprint) => {
  const result = await dialog.showMessageBox(
    BrowserWindow.getFocusedWindow() || window!,
    {
      type: "question",
      title: "SSH 호스트 키 확인",
      message: `${host.name} (${host.address}:${host.port})에 처음 연결합니다.`,
      detail: `서버의 지문이 맞는지 확인해 주세요.\n\n${fingerprint}`,
      buttons: ["취소", "지문 확인 후 연결"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    },
  );
  return result.response === 1;
};
const bootstrap = (caller = window!): Bootstrap => ({
  document: store.read(),
  appVersion: app.getVersion(),
  profiles: store.profiles(),
  platform: process.platform,
  home: os.homedir(),
  fonts,
  windowId: caller.id,
  workspaceOwners: ownerRecord(),
  sessionStates: [...states.values()],
  tunnelStates: [...tunnels.states.values()],
  shells: availableShells(),
});
const pathSchema = z
  .string()
  .max(4096)
  .refine(
    (p) => !/[\0\r\n]/.test(p),
    "경로에 줄바꿈이나 NUL을 사용할 수 없습니다.",
  );
const idObject = z.object({ id: idSchema });
const schemas: Record<Call, z.ZodType> = {
  bootstrap: z.undefined(),
  save: documentSchema,
  "auth.save": z.object({
    id: idSchema,
    name: z.string().min(1).max(256),
    username: z
      .string()
      .max(256)
      .refine((v) => !/[\r\n\0]/.test(v))
      .optional(),
    secret: secretSchema,
  }),
  "auth.delete": idObject,
  "key.pick": z.undefined(),
  "session.connect": z.object({
    id: idSchema,
    hostId: idSchema,
    secret: secretSchema.optional(),
  }),
  "session.execute": z.object({
    ids: z.array(idSchema).min(1).max(16),
    command: z.string().max(65536),
  }),
  "session.broadcast": z.object({
    source: idSchema,
    ids: z.array(idSchema).min(1).max(16),
    data: z.string().max(65536),
  }),
  "command.suggest": z.object({
    query: z.string().max(512),
    endpointId: idSchema.optional(),
    path: pathSchema.optional(),
  }),
  "local.shells": z.undefined(),
  "tunnel.start": z.object({ id: idSchema, secret: secretSchema.optional() }),
  "tunnel.stop": idObject,
  "logs.list": z.undefined(),
  "logs.record": z.object({ id: idSchema, enabled: z.boolean() }),
  "logs.read": z.object({
    id: idSchema,
    query: z.string().max(512).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  "logs.bookmark": z.object({
    id: idSchema,
    offset: z.number().int().min(0),
    label: z.string().min(1).max(256),
  }),
  "logs.export": idObject,
  "logs.delete": idObject,
  "theme.import": z.undefined(),
  "theme.export": idObject,
  "window.list": z.undefined(),
  "window.move": z.object({
    workspaceId: idSchema,
    target: z.number().int().positive().optional(),
  }),
  "window.snapshot": z.object({
    token: idSchema,
    snapshots: z
      .array(
        z.object({
          id: idSchema,
          data: z.string().max(16 * 1024 * 1024),
          cols: z.number().int().min(2).max(1000),
          rows: z.number().int().min(1).max(500),
          appearance: appearanceOverridesSchema.optional(),
        }),
      )
      .max(16),
  }),
  "session.close": idObject,
  "session.input": z.object({
    id: idSchema,
    data: z.string().max(262144),
    binary: z.boolean().optional(),
  }),
  "session.resize": z.object({
    id: idSchema,
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(500),
  }),
  "session.ack": z.object({
    id: idSchema,
    bytes: z.number().int().min(0).max(262144),
  }),
  "files.connections": z.undefined(),
  "files.connect": z.object({
    hostId: idSchema.nullable(),
    secret: secretSchema.optional(),
    previousId: idSchema.optional(),
  }),
  "files.close": idObject,
  "files.list": z.object({ id: idSchema, path: pathSchema }),
  "files.action": z.object({
    id: idSchema,
    action: z.enum(["mkdir", "touch", "rename", "delete", "chmod"]),
    paths: z.array(pathSchema).min(1).max(10000),
    name: z.string().max(255).optional(),
    mode: z.number().int().min(0).max(511).optional(),
  }),
  "transfer.add": z.object({
    source: idSchema,
    destination: idSchema,
    paths: z.array(pathSchema).min(1).max(10000),
    target: pathSchema,
    conflict: z.enum(["skip", "overwrite", "rename"]),
  }),
  "transfer.cancel": idObject,
  "transfer.retry": idObject,
  "data.export": z.object({
    password: z.string().min(10).max(1024).optional(),
    kind: z.enum(["passport", "snippets"]).optional(),
  }),
  "data.preview": z.object({
    password: z.string().max(1024).optional(),
    kind: z.enum(["passport", "ssh", "snippets"]).optional(),
  }),
  "data.apply": z.object({
    token: idSchema,
    conflict: z.enum(["skip", "overwrite"]),
  }),
  "backup.list": z.undefined(),
  "backup.preview": z.object({
    name: z.string().regex(/^\d{4}-\d{2}-\d{2}\.json$/),
  }),
  "clipboard.read": z.undefined(),
  "clipboard.write": z.object({ text: z.string().max(4 * 1024 * 1024) }),
};
function preview(
  data: Portable,
  warnings: string[] = [],
  kind: ImportPreview["kind"] = "passport",
): ImportPreview {
  previews.clear();
  const token = randomUUID();
  previews.set(token, { data, warnings, kind });
  setTimeout(() => previews.delete(token), 5 * 60 * 1000).unref();
  const current = store.read();
  const duplicates = data.document.hosts.filter((h) =>
    current.hosts.some(
      (c) => c.id === h.id || hostIdentity(c) === hostIdentity(h),
    ),
  ).length;
  if (data.document.hosts.some((h) => h.startPath))
    warnings.push("가져온 시작 경로를 서버에서 확인해 주세요.");
  const availableFonts = new Set(["JetBrains Mono", ...fonts]);
  if (!availableFonts.has(data.document.settings.appearance.font)) {
    warnings.push(
      `설치되지 않은 글꼴 ${data.document.settings.appearance.font}을 JetBrains Mono로 대체합니다.`,
    );
    data.document.settings.appearance.font = "JetBrains Mono";
  }
  for (const host of data.document.hosts) {
    if (host.appearance.font && !availableFonts.has(host.appearance.font)) {
      warnings.push(
        `${host.name}: 설치되지 않은 글꼴을 기본 글꼴로 대체합니다.`,
      );
      delete host.appearance.font;
    }
  }
  for (const group of data.document.groups) {
    const appearance = group.defaults.appearance;
    if (appearance?.font && !availableFonts.has(appearance.font)) {
      delete appearance.font;
      warnings.push(
        `${group.name}: 설치되지 않은 그룹 글꼴을 기본 글꼴로 대체합니다.`,
      );
    }
  }
  for (const workspace of data.document.workspaces)
    for (const pane of panes(workspace.root)) {
      if (!pane.local) continue;
      if (pane.local.cwd) {
        pane.local.cwd = "";
        warnings.push(
          `${workspace.name}: 로컬 시작 폴더는 현재 기기에서 다시 지정합니다.`,
        );
      }
      if (!availableShells().some((s) => s.id === pane.local!.shell)) {
        pane.local.shell = "default";
        warnings.push(
          `${workspace.name}: 설치되지 않은 셸을 기본 셸로 대체합니다.`,
        );
      }
    }
  // Imported absolute local key paths are never opened. Private key material only comes from an explicit file picker or encrypted package.
  return {
    token,
    document: data.document,
    profiles: data.profiles,
    duplicates,
    warnings,
    kind,
  };
}
function secretFor(hostId: string, override?: Secret, sftp = false) {
  const document = store.read();
  const raw = document.hosts.find((h) => h.id === hostId);
  const host = raw
    ? connectionHost(
        document,
        effectiveHost(document, raw),
        store.profiles(),
        sftp,
      )
    : undefined;
  if (!host) throw new Error("호스트를 찾을 수 없습니다.");
  const authId =
    sftp && (host.protocol === "ssh" || host.protocol === "sftp")
      ? (host.sftpAuthId ?? host.authId)
      : host.authId;
  const secret = override ?? store.getSecret(authId);
  if (!secret) throw new Error("인증 정보를 입력해 주세요.");
  return { host, secret };
}
async function call<K extends Call>(
  name: K,
  input: Calls[K]["input"],
  caller: BrowserWindow,
): Promise<unknown> {
  // Every channel is validated before dispatch; operation-specific types are narrowed here.
  const i = input as any;
  // Layout/output callbacks may already be queued when a pane is removed or moved.
  // Drop stale housekeeping without allowing the previous window to affect its new owner.
  if (
    (name === "session.resize" || name === "session.ack") &&
    ownerOf(i.id) !== caller.id
  )
    return;
  if (
    [
      "session.close",
      "session.input",
      "session.resize",
      "session.ack",
      "logs.record",
    ].includes(name)
  )
    assertOwned(i.id, caller);
  if (
    ["files.close", "files.list", "files.action"].includes(name) &&
    endpointOwners.get(i.id) !== caller.id
  )
    throw new Error("이 창의 파일 연결이 아닙니다.");
  switch (name) {
    case "bootstrap":
      return bootstrap(caller);
    case "save": {
      if (moves.size)
        throw new Error("창 이동이 완료된 후 다시 시도해 주세요.");
      const doc = documentSchema.parse(input);
      const previous = store.read();
      if (doc.revision !== previous.revision)
        throw new Error(
          "다른 창에서 설정을 변경했습니다. 최신 설정을 불러온 뒤 다시 시도해 주세요.",
        );
      validateShortcuts(doc.settings.shortcuts);
      for (const w of doc.workspaces)
        if (!owners.has(w.id)) owners.set(w.id, caller.id);
      const removed = [...files.adapters.values()].filter(
        (a) =>
          a.endpoint.hostId &&
          !doc.hosts.some((h) => h.id === a.endpoint.hostId),
      );
      if (removed.some((a) => transfers.busy(a.endpoint.id)))
        throw new Error("전송 중인 호스트는 삭제할 수 없습니다.");
      doc.hosts = doc.hosts.map((h) => ({
        ...h,
        lastConnected: Math.max(
          h.lastConnected,
          previous.hosts.find((p) => p.id === h.id)?.lastConnected ?? 0,
        ),
      }));
      const saved = store.save(doc);
      if (doc.settings.autoLog !== previous.settings.autoLog) {
        for (const [id, state] of states) {
          if (!doc.settings.autoLog) logs.stop(id);
          else if (state.status === "connected") {
            try {
              logs.start(id, sessionLogName(id));
            } catch (error) {
              emit({
                kind: "notice",
                message: `로그 기록 실패: ${error instanceof Error ? error.message : "저장 오류"}`,
              });
            }
          }
        }
      }
      logs.prune();
      const allowed = new Set(
        doc.workspaces.flatMap((w) => panes(w.root).map((p) => p.id)),
      );
      for (const id of sessions.sessions.keys())
        if (!allowed.has(id)) closeSession(id);
      nativeTheme.themeSource = doc.settings.colorMode;
      for (const a of removed) await files.close(a.endpoint.id);
      for (const id of locals.sessions.keys())
        if (!allowed.has(id)) closeSession(id);
      for (const [id, running] of tunnels.running)
        if (
          JSON.stringify(doc.tunnels.find((t) => t.id === id)) !==
          JSON.stringify(running.rule)
        )
          tunnels.stop(id);
      publishDocument();
      return saved;
    }
    case "auth.save": {
      const profiles = store.saveSecret(i.id, i.name, i.secret, i.username);
      publishDocument();
      return profiles;
    }
    case "auth.delete": {
      const profiles = store.deleteSecret(i.id);
      publishDocument();
      return profiles;
    }
    case "key.pick": {
      const result = await dialog.showOpenDialog(caller, {
        title: "SSH 개인 키 선택",
        properties: ["openFile"],
      });
      if (result.canceled) return null;
      const stat = await fs.stat(result.filePaths[0]);
      if (stat.size > 1048576)
        throw new Error("키 파일은 1MB 이하여야 합니다.");
      return await fs.readFile(result.filePaths[0], "utf8");
    }
    case "session.connect": {
      const current = store.read();
      if (
        !current.workspaces
          .flatMap((w) => panes(w.root))
          .some((p) => p.id === i.id && p.hostId === i.hostId)
      )
        throw new Error("현재 작업 배치에 없는 터미널입니다.");
      assertOwned(i.id, caller);
      const pane = current.workspaces
        .flatMap((w) => panes(w.root))
        .find((p) => p.id === i.id)!;
      if (pane.local) {
        locals.open(i.id, pane.local);
        return;
      }
      const { host, secret } = secretFor(i.hostId, i.secret);
      const startup = host.startupSnippetId
        ? current.snippets.find((s) => s.id === host.startupSnippetId)?.content
        : undefined;
      if (startup && /\{\{/.test(startup))
        throw new Error("시작 스니펫은 입력 변수가 없는 명령을 선택하세요.");
      await sessions.open(
        i.id,
        host,
        secret,
        startup ? executableCommand(startup) : undefined,
      );
      const latest = store.read();
      if (sessions.sessions.get(i.id)?.status === "connected")
        store.save({
          ...latest,
          hosts: latest.hosts.map((h) =>
            h.id === host.id ? { ...h, lastConnected: Date.now() } : h,
          ),
        });
      publishDocument();
      return;
    }
    case "session.close":
      closeSession(i.id);
      return;
    case "session.input":
      if (locals.sessions.has(i.id)) locals.input(i.id, i.data);
      else sessions.input(i.id, i.data, i.binary);
      return;
    case "session.resize":
      if (locals.sessions.has(i.id)) locals.resize(i.id, i.cols, i.rows);
      else sessions.resize(i.id, i.cols, i.rows);
      return;
    case "session.ack":
      if (locals.sessions.has(i.id)) locals.ack(i.id, i.bytes);
      else sessions.ack(i.id, i.bytes);
      return;
    case "files.connections":
      return [...files.adapters.values()]
        .filter((a) => endpointOwners.get(a.endpoint.id) === caller.id)
        .map((a) => a.endpoint);
    case "files.connect": {
      const previous = i.previousId
        ? files.adapters.get(i.previousId)
        : undefined;
      if (previous && transfers.busy(previous.endpoint.id))
        throw new Error("전송을 완료하거나 취소한 후 연결을 바꿔 주세요.");
      const config = i.hostId
        ? secretFor(i.hostId, i.secret, true)
        : { host: null, secret: undefined };
      if (previous && endpointOwners.get(previous.endpoint.id) !== caller.id)
        throw new Error("이 창의 파일 연결이 아닙니다.");
      const next = await files.open(config.host, config.secret);
      endpointOwners.set(next.id, caller.id);
      if (previous) {
        if (
          previous.endpoint.hostId === next.hostId &&
          previous.endpoint.protocol === next.protocol
        )
          transfers.rebind(previous.endpoint.id, next.id);
        await files.close(previous.endpoint.id);
      }
      return next;
    }
    case "files.close":
      if (transfers.busy(i.id))
        throw new Error("전송이 진행 중입니다. 먼저 완료하거나 취소해 주세요.");
      await files.close(i.id);
      return;
    case "files.list":
      return files.list(i.id, i.path);
    case "files.action":
      if (transfers.busy(i.id))
        throw new Error("전송 완료 후 파일을 변경해 주세요.");
      return files.action(i.id, i.action, i.paths, i.name, i.mode);
    case "transfer.add":
      if (
        [i.source, i.destination].some(
          (id) => endpointOwners.get(id) !== caller.id,
        )
      )
        throw new Error("이 창의 파일 연결만 전송할 수 있습니다.");
      return transfers.add(i);
    case "transfer.cancel":
    case "transfer.retry": {
      const job = transfers.jobs.get(i.id);
      if (
        !job ||
        [job.source, job.destination].some(
          (id) => endpointOwners.get(id) !== caller.id,
        )
      )
        throw new Error("이 창의 전송 작업이 아닙니다.");
      if (name === "transfer.retry") return transfers.retry(i.id);
      transfers.cancel(i.id);
      return;
    }
    case "clipboard.read":
      return clipboard.readText();
    case "clipboard.write":
      clipboard.writeText(i.text);
      return;
    case "data.export": {
      const result = await dialog.showSaveDialog(caller, {
        title: "파일 내보내기",
        defaultPath:
          i.kind === "snippets"
            ? "passport-snippets.json"
            : i.password
              ? "passport-encrypted.json"
              : "passport.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return false;
      const data =
        i.kind === "snippets"
          ? JSON.stringify(
              {
                format: "passport-snippets",
                version: 1,
                snippets: store.read().snippets,
              },
              null,
              2,
            )
          : await encodePortable(store.portable(!!i.password), i.password);
      await fs.writeFile(result.filePath, data, { mode: 0o600 });
      return true;
    }
    case "data.preview": {
      const result = await dialog.showOpenDialog(caller, {
        title: "파일 가져오기",
        properties: ["openFile"],
      });
      if (result.canceled) return null;
      const stat = await fs.stat(result.filePaths[0]);
      if (stat.size > 24 * 1024 * 1024)
        throw new Error("파일은 24MB 이하여야 합니다.");
      const text = await fs.readFile(result.filePaths[0], "utf8");
      if (i.kind === "ssh") {
        const parsed = parseSSHConfig(text);
        return preview(
          {
            format: "passport",
            version: 1,
            document: parsed.document,
            profiles: [],
          },
          parsed.warnings,
          "ssh",
        );
      }
      if (i.kind === "snippets") {
        const parsed = z
          .object({
            format: z.literal("passport-snippets"),
            version: z.literal(1),
            snippets: z.array(snippetSchema).max(5000),
          })
          .parse(safeJson(text));
        return preview(
          {
            format: "passport",
            version: 1,
            document: { ...emptyDocument(), snippets: parsed.snippets },
            profiles: [],
          },
          [],
          "snippets",
        );
      }
      return preview(await decodePortable(text, i.password));
    }
    case "data.apply": {
      if (moves.size)
        throw new Error("창 이동이 완료된 후 다시 시도해 주세요.");
      const item = previews.get(i.token);
      if (!item) throw new Error("가져오기 미리보기가 만료되었습니다.");
      const merged = mergePortable(
        store.read(),
        store.profiles(),
        item.data,
        i.conflict,
      );
      if (item.kind !== "passport") {
        merged.document.settings = store.read().settings;
      }
      validateShortcuts(merged.document.settings.shortcuts);
      store.apply(merged.document, merged.profiles, merged.secrets);
      for (const w of merged.document.workspaces)
        if (!owners.has(w.id)) owners.set(w.id, caller.id);
      nativeTheme.themeSource = merged.document.settings.colorMode;
      const allowed = new Set(
        merged.document.workspaces.flatMap((w) =>
          panes(w.root).map((p) => p.id),
        ),
      );
      for (const id of sessions.sessions.keys())
        if (!allowed.has(id)) closeSession(id);
      for (const id of locals.sessions.keys())
        if (!allowed.has(id)) closeSession(id);
      for (const [id, running] of tunnels.running)
        if (
          JSON.stringify(merged.document.tunnels.find((t) => t.id === id)) !==
          JSON.stringify(running.rule)
        )
          tunnels.stop(id);
      publishDocument();
      previews.delete(i.token);
      return bootstrap(caller);
    }
    case "local.shells":
      return availableShells();
    case "session.execute": {
      const command = executableCommand(i.command);
      const ids = [...new Set<string>(i.ids)];
      const workspace = workspaceFor(ids[0]);
      for (const id of ids) {
        assertOwned(id, caller);
        if (
          workspaceFor(id)?.id !== workspace?.id ||
          states.get(id)?.status !== "connected"
        )
          throw new Error("같은 작업 탭의 연결된 터미널만 실행할 수 있습니다.");
      }
      for (const id of ids) {
        if (locals.sessions.has(id)) locals.input(id, command + "\r");
        else sessions.input(id, command + "\r");
      }
      logs.remember(command);
      return;
    }
    case "session.broadcast": {
      assertOwned(i.source, caller);
      const workspace = workspaceFor(i.source);
      if (!workspace) throw new Error("작업 탭이 없습니다.");
      const ids = [...new Set<string>(i.ids)];
      const allowed = panes(workspace.root)
        .filter((p) => !p.local)
        .map((p) => p.id);
      if (!allowed.includes(i.source))
        throw new Error("로컬 터미널은 동시 입력에서 제외됩니다.");
      for (const id of ids) {
        assertOwned(id, caller);
        if (!allowed.includes(id) || states.get(id)?.status !== "connected")
          throw new Error("동시 입력 대상 연결을 확인하세요.");
      }
      for (const id of ids) sessions.input(id, i.data);
      return;
    }
    case "command.suggest": {
      const query = i.query.toLowerCase();
      const suggestions: Calls["command.suggest"]["output"] = store
        .read()
        .snippets.filter((s) =>
          (s.name + " " + s.content).toLowerCase().includes(query),
        )
        .slice(0, 30)
        .map((s) => ({ text: s.content, source: "snippet" }));
      suggestions.push(
        ...logs
          .history(query)
          .map((text) => ({ text, source: "history" as const })),
      );
      if (i.endpointId && i.path) {
        if (endpointOwners.get(i.endpointId) !== caller.id)
          throw new Error("이 창의 파일 연결이 아닙니다.");
        const listing = await files.list(i.endpointId, i.path);
        suggestions.push(
          ...listing.entries
            .filter((e) => e.name.toLowerCase().includes(query))
            .slice(0, 30)
            .map((e) => ({
              text: "'" + e.path.replace(/'/g, "'\\''") + "'",
              source: "path" as const,
            })),
        );
      }
      return suggestions.slice(0, 60);
    }
    case "tunnel.start": {
      const rule = store.read().tunnels.find((t) => t.id === i.id);
      if (!rule) throw new Error("터널 규칙이 없습니다.");
      const { host, secret } = secretFor(rule.hostId, i.secret);
      if (host.protocol !== "ssh") throw new Error("SSH 호스트를 선택하세요.");
      return tunnels.start(rule, host, secret);
    }
    case "tunnel.stop":
      tunnels.stop(i.id);
      return;
    case "logs.list":
      return logs.list();
    case "logs.record": {
      if (i.enabled) {
        if (states.get(i.id)?.status !== "connected")
          throw new Error("연결된 세션에서 기록을 시작하세요.");
        const p = workspaceFor(i.id)!.root;
        logs.start(i.id, workspaceFor(i.id)!.name);
      } else logs.stop(i.id);
      return;
    }
    case "logs.read":
      return logs.read(i.id, i.offset, i.query);
    case "logs.bookmark":
      logs.bookmark(i.id, i.offset, i.label);
      return;
    case "logs.delete":
      logs.delete(i.id);
      return;
    case "logs.export": {
      const row = logs.get(i.id);
      const result = await dialog.showSaveDialog(caller, {
        title: "세션 로그 내보내기",
        defaultPath: `passport-${row.id}.log`,
      });
      if (result.canceled || !result.filePath) return false;
      logs.export(i.id, result.filePath);
      return true;
    }
    case "theme.import": {
      const result = await dialog.showOpenDialog(caller, {
        title: "사용자 테마 가져오기",
        properties: ["openFile"],
        filters: [{ name: "JSON 테마", extensions: ["json"] }],
      });
      if (result.canceled) return null;
      const size = (await fs.stat(result.filePaths[0])).size;
      if (size > 65536) throw new Error("테마 파일은 64KB 이하여야 합니다.");
      return customThemeSchema.parse(
        safeJson(await fs.readFile(result.filePaths[0], "utf8")),
      );
    }
    case "theme.export": {
      const theme = store
        .read()
        .settings.customThemes.find((t) => t.id === i.id);
      if (!theme) throw new Error("사용자 테마가 없습니다.");
      const result = await dialog.showSaveDialog(caller, {
        title: "사용자 테마 내보내기",
        defaultPath: "passport-theme.json",
      });
      if (result.canceled || !result.filePath) return false;
      await fs.writeFile(result.filePath, JSON.stringify(theme, null, 2), {
        mode: 0o600,
      });
      return true;
    }
    case "window.list":
      return [...windows.values()].map((w) => ({
        id: w.id,
        title: `Passport 창 ${w.id}`,
      }));
    case "window.move": {
      const workspace = store
        .read()
        .workspaces.find((w) => w.id === i.workspaceId);
      if (!workspace || owners.get(workspace.id) !== caller.id)
        throw new Error("이 창의 작업 탭만 이동할 수 있습니다.");
      if (moves.has(workspace.id)) throw new Error("창 이동이 진행 중입니다.");
      const target = i.target ? windows.get(i.target) : await createWindow();
      if (!target || target.id === caller.id)
        throw new Error("다른 창을 선택하세요.");
      const token = randomUUID();
      const timer = setTimeout(() => {
        const pending = moves.get(workspace.id);
        if (!pending) return;
        moves.delete(workspace.id);
        for (const event of pending.events) emit(event, true);
      }, 15000);
      moves.set(workspace.id, {
        token,
        source: caller.id,
        target: target.id,
        events: [],
        timer,
      });
      caller.webContents.send("passport:event", {
        kind: "window-transfer",
        token,
        workspaceId: workspace.id,
        target: target.id,
      } satisfies AppEvent);
      return;
    }
    case "window.snapshot": {
      const pair = [...moves].find(
        ([, m]) => m.token === i.token && m.source === caller.id,
      );
      if (!pair) throw new Error("창 이동 요청이 만료되었습니다.");
      const [workspaceId, moving] = pair;
      if (
        i.snapshots.reduce(
          (total: number, s: TerminalSnapshot) =>
            total + Buffer.byteLength(s.data),
          0,
        ) >
        64 * 1024 ** 2
      )
        throw new Error(
          "터미널 버퍼가 너무 큽니다. 스크롤백을 비운 뒤 이동하세요.",
        );
      const workspace = store
        .read()
        .workspaces.find((w) => w.id === workspaceId);
      const expected = workspace ? panes(workspace.root).map((p) => p.id) : [];
      if (
        i.snapshots.length !== expected.length ||
        new Set(i.snapshots.map((s: TerminalSnapshot) => s.id)).size !==
          expected.length ||
        i.snapshots.some((s: TerminalSnapshot) => !expected.includes(s.id))
      )
        throw new Error("터미널 상태가 일치하지 않습니다.");
      const target = windows.get(moving.target);
      if (!target) throw new Error("대상 창이 닫혔습니다.");
      clearTimeout(moving.timer);
      moves.delete(workspaceId);
      owners.set(workspaceId, target.id);
      publishDocument();
      target.webContents.send("passport:event", {
        kind: "hydrate",
        workspaceId,
        snapshots: i.snapshots,
      } satisfies AppEvent);
      for (const id of expected) {
        const state = states.get(id);
        if (state)
          target.webContents.send("passport:event", { kind: "session", state });
      }
      for (const event of moving.events)
        target.webContents.send("passport:event", event);
      target.focus();
      return;
    }

    case "backup.list":
      return store.backups();
    case "backup.preview":
      return preview(store.readBackup(i.name));
  }
}
async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "Passport",
    backgroundColor: "#171b20",
    icon: path.join(app.getAppPath(), "build/icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  windows.set(win.id, win);
  if (!window) window = win;
  for (const w of store.read().workspaces)
    if (!owners.has(w.id)) owners.set(w.id, win.id);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  const releaseConnections = () => {
    for (const [id, move] of moves)
      if (move.source === win.id || move.target === win.id) {
        clearTimeout(move.timer);
        moves.delete(id);
        for (const event of move.events) emit(event, true);
      }
    for (const w of store.read().workspaces)
      if (owners.get(w.id) === win.id)
        for (const p of panes(w.root)) closeSession(p.id);
    for (const [id, owner] of endpointOwners)
      if (owner === win.id) {
        for (const job of transfers.jobs.values())
          if (job.source === id || job.destination === id)
            transfers.cancel(job.id);
        void files.close(id);
        endpointOwners.delete(id);
      }
  };
  win.webContents.on("render-process-gone", releaseConnections);
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) releaseConnections();
  });
  let closing = false;
  win.on("close", (event) => {
    if (closing) return;
    if (
      [...states.values()].some(
        (s) =>
          ownerOf(s.id) === win.id &&
          ["connected", "connecting"].includes(s.status),
      ) ||
      [...transfers.jobs.values()].some(
        (j) =>
          (endpointOwners.get(j.source) === win.id ||
            endpointOwners.get(j.destination) === win.id) &&
          ["running", "queued"].includes(j.state),
      )
    ) {
      event.preventDefault();
      void dialog
        .showMessageBox(win, {
          type: "question",
          message: "연결과 전송을 종료하고 Passport를 닫을까요?",
          buttons: ["계속 사용", "종료"],
          cancelId: 0,
          defaultId: 0,
        })
        .then((r) => {
          if (r.response === 1) {
            closing = true;
            if (quitting) app.quit();
            else win?.close();
          } else {
            quitting = false;
          }
        });
    }
  });
  win.on("closed", () => {
    releaseConnections();
    windows.delete(win.id);
    window = windows.values().next().value;
    for (const [workspace, id] of owners)
      if (id === win.id) {
        if (window) owners.set(workspace, window.id);
        else owners.delete(workspace);
      }
    publishDocument();
  });
  const dev =
    !app.isPackaged && process.env.PASSPORT_DEV_URL === "http://127.0.0.1:5173";
  await win.loadURL(
    dev ? "http://127.0.0.1:5173" : "passport://app/index.html",
  );
  return win;
}
void app
  .whenReady()
  .then(async () => {
    fonts = await getFonts({ disableQuoting: true }).catch(() => []);
    store = new Store(app.getPath("userData"), safeStorage);
    logs = new SessionLogs(store, (message) =>
      emit({ kind: "notice", message }),
    );
    locals = new LocalSessions(emit);
    tunnels = new Tunnels(store, confirm, (state) =>
      emit({ kind: "tunnel", state }),
    );
    const detectedOS = (host: import("../shared/model").Host, os: string) => {
      const doc = store.read();
      const current = doc.hosts.find((h) => h.id === host.id);
      if (!current || current.detectedOS === os) return;
      const effective = effectiveHost(doc, current);
      if (effective.address !== host.address || effective.port !== host.port)
        return;
      store.save({
        ...doc,
        hosts: doc.hosts.map((h) =>
          h.id === host.id ? { ...h, detectedOS: os } : h,
        ),
      });
      publishDocument();
    };
    sessions = new Sessions(store, confirm, emit, detectedOS);
    files = new Files(store, confirm, detectedOS);
    transfers = new Transfers(files, emit);
    nativeTheme.themeSource = store.read().settings.colorMode;
    const renderer = path.join(__dirname, "../renderer");
    protocol.handle("passport", (request) => {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Forbidden", { status: 403 });
      const file = path.resolve(
        renderer,
        "." + decodeURIComponent(url.pathname),
      );
      if (!file.startsWith(renderer + path.sep))
        return new Response("Forbidden", { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on("will-download", (event) =>
      event.preventDefault(),
    );
    ipcMain.handle("passport:call", async (event, name: Call, raw: unknown) => {
      try {
        const caller = BrowserWindow.fromWebContents(event.sender);
        if (
          !caller ||
          !windows.has(caller.id) ||
          event.senderFrame !== caller.webContents.mainFrame
        )
          throw new Error("허용되지 않은 호출입니다.");
        if (!Object.hasOwn(schemas, name))
          throw new Error("알 수 없는 요청입니다.");
        const parsed = schemas[name].parse(raw);
        return { ok: true, value: await call(name, parsed as never, caller) };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof z.ZodError
              ? `입력값을 확인해 주세요: ${error.issues[0]?.message}`
              : error instanceof Error
                ? error.message
                : "작업에 실패했습니다.",
        };
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Passport",
          submenu: [
            { label: "Passport 정보", role: "about" },
            { type: "separator" },
            { label: "종료", role: "quit" },
          ],
        },
        {
          label: "편집",
          submenu: [
            { label: "실행 취소", role: "undo" },
            { label: "다시 실행", role: "redo" },
            { type: "separator" },
            { label: "잘라내기", role: "cut" },
            {
              label: "복사",
              role: "copy",
              registerAccelerator: false,
              accelerator:
                process.platform === "darwin" ? "Command+C" : "Control+Shift+C",
            },
            {
              label: "붙여넣기",
              role: "paste",
              registerAccelerator: false,
              accelerator:
                process.platform === "darwin" ? "Command+V" : "Control+Shift+V",
            },
            { label: "전체 선택", role: "selectAll" },
          ],
        },
        {
          label: "보기",
          submenu: [
            { label: "전체 화면", role: "togglefullscreen" },
            ...(!app.isPackaged
              ? [{ label: "개발자 도구", role: "toggleDevTools" as const }]
              : []),
          ],
        },
      ]),
    );
    try {
      store.backup();
    } catch (error) {
      console.error(
        "로컬 백업 실패",
        error instanceof Error ? error.name : "오류",
      );
    }
    backupTimer = setInterval(
      () => {
        try {
          store.backup();
        } catch {}
      },
      60 * 60 * 1000,
    );
    backupTimer.unref();
    logPruneTimer = setInterval(() => {
      try {
        logs.prune();
      } catch (error) {
        emit({
          kind: "notice",
          message: `로그 정리 실패: ${error instanceof Error ? error.message : "저장 오류"}`,
        });
      }
    }, 60_000);
    logPruneTimer.unref();
    await createWindow();
    app.on("activate", () => {
      if (!window) void createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox(
      "Passport 시작 실패",
      error instanceof Error ? error.message : "앱을 시작할 수 없습니다.",
    );
    app.quit();
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  clearInterval(backupTimer);
  clearInterval(logPruneTimer);
});
app.on("will-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdown) return;
  shutdown = (async () => {
    tunnels?.closeAll();
    sessions?.closeAll();
    transfers?.cancelAll();
    files?.closeAll();
    await locals?.shutdown();
    store?.close();
    shutdownComplete = true;
    app.quit();
  })();
});
