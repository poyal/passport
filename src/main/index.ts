import { ignoreShortcutMenu, type ShortcutContext } from "../shared/shortcuts";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  nativeTheme,
  nativeImage,
  session,
  clipboard,
  protocol,
  net,
  Menu,
  shell,
  Notification,
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
  localShellSchema,
  type Activity,
} from "../shared/model";
import { Store } from "./store";
import { SessionResume } from "./session-resume";
import { ResumeOutput } from "./ssh-resume";
import {
  resumeScreenSchema,
  resumeReconnectMessage,
} from "../shared/session-resume";
import { agentResumeCommand, agentResumeProblem } from "./agent-resume";
import { ShareStore } from "./share/store";
import { ShareService } from "./share/service";
import {
  shareSettingsSchema,
  shareSendSchema,
  shareLabel,
  shareEndpointSchema,
  shareExtensions,
  shareFileName,
} from "../shared/share";
import { Sessions, type TrustPrompt } from "./ssh";
import { Files } from "./files";
import { Transfers } from "./transfers";
import {
  decodePortable,
  isEncryptedPortable,
  encodePortable,
  mergePortable,
  parseSSHConfig,
  hostIdentity,
  safeJson,
  type Portable,
} from "./portable";
import { LocalSessions, availableShells } from "./local";
import { ActivityService } from "./activity";
import { TerminalControl, ControlInspector } from "./terminal-control";
import {
  controlInspectionSchema,
  type ControlPanel,
} from "../shared/terminal-control";
import type { AppliedEnvironment } from "../shared/terminal-config";
import { ActivityBanners } from "./activity-banners";
import { prepareTerminalClipboard } from "./terminal-clipboard";
import { prepareTerminalDrop } from "./terminal-drop";
import { sshFileDropMessage } from "../shared/paste";
import { terminalLinkURL } from "./terminal-links";
import { platform } from "./platform";
import { prepareLaunch, previewEnvironment } from "./startup";
import {
  selectedProfiles,
  unicodeWidthSchema,
} from "../shared/terminal-config";
import { SessionLogs } from "./logs";
import { Tunnels } from "./tunnels";
import {
  effectiveHost,
  connectionHost,
  executableCommand,
  validateShortcuts,
} from "../shared/advanced";
import { panes } from "../shared/layout";
import { bundledFonts } from "../shared/fonts";
import {
  assertTerminalCapacity,
  localWorkspace,
} from "../shared/local-workspace";
import { about } from "../shared/about";
import { UpdateChecker } from "./updates";
import { resolveAppIdentity } from "./app-identity";
import {
  testWindowMode,
  testWindowOptions,
  presentWindow,
} from "./test-window";

const appIdentity = resolveAppIdentity(app.getVersion(), app.isPackaged);
const developmentBuild = appIdentity.development;
const appVersion = appIdentity.version;
app.setName(appIdentity.name);
const e2eWindowMode = testWindowMode(process.env);
platform.desktop.initialize(app, e2eWindowMode, appIdentity);
const e2eWindowAudit = {
  mode: e2eWindowMode,
  created: 0,
  shown: 0,
  focused: 0,
};
if (e2eWindowMode) {
  Object.assign(globalThis, { __passportE2EWindowAudit: e2eWindowAudit });
  app.on("browser-window-focus", () => e2eWindowAudit.focused++);
}
if (process.env.PASSPORT_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.PASSPORT_DATA_DIR));
else if (developmentBuild)
  app.setPath("userData", path.join(app.getPath("appData"), appIdentity.name));
const desktopNotifications = {
  isSupported: () => Notification.isSupported(),
  create: (options: Electron.NotificationConstructorOptions) =>
    new Notification(options),
};
// Delivery-policy E2E must not register native OS shortcuts or toast handlers.
// Expose the adapter only when that fixture explicitly uses an isolated DB.
if (
  process.env.PASSPORT_E2E_NOTIFICATIONS === "1" &&
  process.env.PASSPORT_DATA_DIR
)
  Object.assign(globalThis, {
    __passportE2ENotifications: desktopNotifications,
  });
// Share one process across app copies using the same settings directory. Separate
// test/development data directories still have independent instances.
const ownsDataDirectory = app.requestSingleInstanceLock();
if (!ownsDataDirectory) app.quit();
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
const encryptedImports = new Map<string, { text: string; owner: number }>();
let fonts: string[] = [];
let updates: UpdateChecker;
let locals: LocalSessions, logs: SessionLogs, tunnels: Tunnels;
let activity: ActivityService;
let resume: SessionResume;
const connectionTickets = new Map<string, string>();
const resumeMessages = new Map<string, string>();
const cwdParsers = new Map<string, ResumeOutput>();
function resumeNotice(id: string, message: string) {
  resumeMessages.set(id, message);
  const state = states.get(id);
  if (state)
    emit({ kind: "session", state: { ...state, resumeMessage: message } });
}
let terminalControl: TerminalControl;
let sharing: ShareService;
const localEnvironments = new Map<string, AppliedEnvironment>();
const controlInspector = new ControlInspector((owner, request) => {
  const destination = windows.get(owner);
  if (!destination || destination.isDestroyed())
    throw new Error("Window closed");
  destination.webContents.send("passport:event", {
    kind: "control-inspect",
    request,
  } satisfies AppEvent);
});
const focusedPanes = new Map<number, string | null>();
const banners = new ActivityBanners<Notification>();
function trackBanner(banner: Notification) {
  banners.track(banner);
}
const windows = new Map<number, BrowserWindow>();
const keyboardContexts = new Map<number, ShortcutContext>();
const initialTerminals = new Map<
  number,
  { workspaceId: string; paneId: string }
>();
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
function controlPanels(): ControlPanel[] {
  return (documentCache ??= store.read()).workspaces.flatMap((workspace) =>
    panes(workspace.root)
      .filter((pane) => pane.local)
      .map((pane) => {
        const environment = localEnvironments.get(pane.id);
        return {
          paneId: pane.id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          windowId: owners.get(workspace.id) ?? -1,
          sessionId: environment?.sessionInstanceId ?? null,
          status: locals.sessions.get(pane.id)?.alive
            ? ("connected" as const)
            : ("disconnected" as const),
          shell: environment?.shell ?? pane.local!.shell,
          launchCwd:
            environment?.cwd ||
            pane.local!.cwd ||
            store.read().settings.terminal.cwd ||
            os.homedir(),
          configuredAgent: environment?.agent ?? pane.local!.agent ?? null,
          moving: moves.has(workspace.id),
        };
      }),
  );
}
function isPaneViewed(paneId: string) {
  const owner = windows.get(ownerOf(paneId) ?? -1);
  return (
    !!owner &&
    !owner.isDestroyed() &&
    owner.isFocused() &&
    owner.isVisible() &&
    !owner.isMinimized() &&
    focusedPanes.get(owner.id) === paneId
  );
}
function publishDocument(document = store.read()) {
  documentCache = document;
  resume?.configure(document);
  terminalControl?.configure(document.settings.terminal.cliAccess);
  const localIds = new Set(
    document.workspaces.flatMap((w) =>
      panes(w.root)
        .filter((p) => p.local)
        .map((p) => p.id),
    ),
  );
  for (const id of localEnvironments.keys())
    if (!localIds.has(id)) localEnvironments.delete(id);
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
function closeSession(id: string, automatic = false, preserveTicket = false) {
  if (!preserveTicket) connectionTickets.delete(id);
  resume?.stop(id, automatic);
  cwdParsers.delete(id);
  terminalControl?.unregister(id);
  activity?.unregister(id);
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
function startSessionLog(id: string) {
  logs.start(id, sessionLogName(id));
  const group = logs.groupFor(id);
  if (group) resume.logGroup(id, group);
}
let quitting = false;
let shutdown: Promise<void> | undefined;
let shutdownComplete = false;
const emit = (event: AppEvent, replay = false) => {
  if (shutdown) return;
  if (event.kind === "session") {
    event.state.generation ??=
      event.state.environment?.sessionInstanceId ??
      resume?.generation(event.state.id);
    event.state.activeAgent =
      event.state.status === "connected"
        ? activity?.activeAgent(event.state.id, event.state.generation)
        : undefined;
    event.state.resumeMessage ??= resumeMessages.get(event.state.id);
    event.state.resumeNeedsReconnect =
      event.state.status === "connected" &&
      resume?.needsReconnect(event.state.id);
    const previous = states.get(event.state.id);
    states.set(event.state.id, event.state);
    if (
      event.state.status === "connected" &&
      previous?.status !== "connected"
    ) {
      const host = sessions.sessions.get(event.state.id)?.host;
      logs.connected(
        event.state.id,
        host && store.fingerprint(host.address, host.port),
      );
      try {
        if (shouldAutoLog(event.state.id)) startSessionLog(event.state.id);
      } catch (error) {
        emit({
          kind: "notice",
          message: `세션 로그를 기록하지 못했습니다: ${error instanceof Error ? error.message : "저장 오류"}`,
        });
      }
    } else if (
      event.state.status === "disconnected" ||
      event.state.status === "error"
    ) {
      void resume?.checkpoint(event.state.id);
      resume?.stop(
        event.state.id,
        resume.get(event.state.id)?.automatic ?? true,
      );
      logs?.stop(event.state.id);
      activity?.unregister(event.state.id);
      terminalControl?.unregister(event.state.id);
    }
  }
  if (event.kind === "output" && !replay) {
    const parser = cwdParsers.get(event.id);
    if (parser) {
      const data = parser.push(event.data);
      if (!data) {
        locals.ack(event.id, event.bytes);
        return;
      }
      event = { ...event, data };
    }
    resume?.dirty(event.id);
    logs?.append(event.id, event.data);
    activity?.observe(event.id, event.data);
  }
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
function shouldAutoLog(id: string) {
  const document = store.read();
  const pane = document.workspaces
    .flatMap((w) => panes(w.root))
    .find((p) => p.id === id);
  return pane?.local
    ? document.settings.terminal.autoLogLocal
    : document.settings.autoLog;
}
async function openActivity(id: string) {
  const deadline = Date.now() + 10000;
  while (moves.has(workspaceFor(activity.active(id).paneId)?.id || "")) {
    if (Date.now() > deadline)
      throw new Error("창 이동이 아직 진행 중입니다. 잠시 후 다시 시도하세요.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const item = activity.active(id);
  const workspace = workspaceFor(item.paneId);
  const target = windows.get(ownerOf(item.paneId) ?? -1);
  if (!workspace || !target || target.isDestroyed())
    throw new Error("터미널 창을 찾을 수 없습니다.");
  presentWindow(target, e2eWindowMode);
  target.webContents.send("passport:event", {
    kind: "activate-pane",
    workspaceId: workspace.id,
    paneId: item.paneId,
  } satisfies AppEvent);
  // Acknowledge after the target renderer actually selects and focuses the pane.
}
function desktopActivity(item: Activity) {
  const settings = store.read().settings.notifications;
  const focused = BrowserWindow.getFocusedWindow();
  if (
    settings.desktop === "off" ||
    (settings.desktop === "background" && focused) ||
    (settings.desktop === "unfocused" &&
      focused &&
      focusedPanes.get(focused.id) === item.paneId) ||
    !desktopNotifications.isSupported()
  )
    return;
  const banner = desktopNotifications.create({
    title: `${workspaceFor(item.paneId)?.name || "Passport"} · ${item.title}`,
    body: settings.preview ? item.body : "Passport에서 터미널을 확인하세요.",
    silent: !settings.sound,
  });
  banners.track(banner, item.id);
  banner.on("click", () => {
    void openActivity(item.id).catch((error) =>
      emit({ kind: "notice", message: String(error) }),
    );
  });
  banner.on("failed", () => {
    banners.delete(banner);
    emit({
      kind: "notice",
      message:
        "운영체제 알림을 표시하지 못했습니다. 알림 권한과 방해 금지 설정을 확인하세요.",
    });
  });
  banner.show();
}
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
const bootstrap = (caller = window!): Bootstrap => {
  const initialTerminal = initialTerminals.get(caller.id);
  initialTerminals.delete(caller.id);
  return {
    document: store.read(),
    appVersion,
    updateState: updates.state,
    profiles: store.profiles(),
    platform: process.platform,
    home: os.homedir(),
    fonts,
    windowId: caller.id,
    initialTerminal,
    workspaceOwners: ownerRecord(),
    sessionStates: [...states.values()],
    resumeSessions: resume?.summaries() ?? [],
    tunnelStates: [...tunnels.states.values()],
    shells: availableShells(),
  };
};
const pathSchema = z
  .string()
  .max(4096)
  .refine(
    (p) => !/[\0\r\n]/.test(p),
    "경로에 줄바꿈이나 NUL을 사용할 수 없습니다.",
  );
const idObject = z.object({ id: idSchema });
const schemas: Record<Call, z.ZodType> = {
  "share.state": z.undefined(),
  "share.dismissError": z.object({ errorId: idSchema }).strict(),
  "share.unlock": z.undefined(),
  "share.reset": z.undefined(),
  "share.configure": shareSettingsSchema,
  "share.invite": z.undefined(),
  "share.join": z
    .object({ key: z.string().max(16000), alias: shareLabel })
    .strict(),
  "share.pair": z
    .object({ id: idSchema, accept: z.boolean(), alias: shareLabel.optional() })
    .strict(),
  "share.peer": z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      name: shareLabel.optional(),
      remove: z.boolean().optional(),
      endpoint: shareEndpointSchema.optional(),
    })
    .strict(),
  "share.send": shareSendSchema,
  "share.approve": z.object({ id: idSchema, accept: z.boolean() }).strict(),
  "share.cancel": idObject,
  "share.message": idObject,
  "share.deleteMessage": idObject,
  "share.openAttachment": idObject,
  "share.folder": z.undefined(),
  "share.file": z.undefined(),
  "control.reply": controlInspectionSchema,
  "terminal.create": z.undefined(),
  "window.create": z.undefined(),
  "window.keyboardContext": z.enum([
    "standard",
    "editing",
    "terminal",
    "files",
    "dialog",
    "recording",
  ]),
  "terminal.folder": z.undefined(),
  "terminal.link": z.object({ id: idSchema, url: z.string().max(8192) }),
  "terminal.drop": z.object({
    id: idSchema,
    paths: z.array(z.string().min(1).max(32768)).min(1).max(1000),
    sessionInstanceId: idSchema,
  }),
  "terminal.preview": z.object({
    local: localShellSchema,
    workspaceId: idSchema.optional(),
  }),
  "activity.list": z.undefined(),
  "activity.read": z.object({ id: idSchema.optional() }),
  "activity.open": idObject,
  "activity.clear": z.undefined(),
  "activity.focus": z.object({ paneId: idSchema.nullable() }),
  "activity.test": z.undefined(),
  "activity.settings": z.undefined(),
  bootstrap: z.undefined(),
  "updates.check": z.undefined(),
  "updates.open": z.object({ target: z.enum(["download", "release"]) }),
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
  "resume.reply": z.object({
    token: z.string().uuid(),
    screen: resumeScreenSchema.optional(),
  }),
  "session.connect": z.object({
    id: idSchema,
    hostId: idSchema,
    secret: secretSchema.optional(),
    onlyIfDisconnected: z.boolean().optional(),
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
  "logs.groups": z.undefined(),
  "logs.readGroup": z.object({
    id: idSchema,
    cursor: z
      .object({
        ordinal: z.number().int().min(0),
        offset: z.number().int().min(0),
      })
      .optional(),
    query: z.string().max(512).optional(),
  }),
  "logs.exportGroup": idObject,
  "logs.deleteGroup": idObject,
  "logs.record": z.object({ id: idSchema, enabled: z.boolean() }),
  "logs.read": z.object({
    id: idSchema,
    query: z.string().max(512).optional(),
    offset: z.number().int().min(0).optional(),
    plain: z.boolean().optional(),
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
          sessionInstanceId: idSchema.optional(),
          data: z.string().max(16 * 1024 * 1024),
          cols: z.number().int().min(2).max(1000),
          rows: z.number().int().min(1).max(500),
          appearance: appearanceOverridesSchema.optional(),
          unicodeWidth: unicodeWidthSchema.optional(),
        }),
      )
      .max(16),
  }),
  "session.close": idObject,
  "session.input": z.object({
    id: idSchema,
    data: z.string().max(262144),
    binary: z.boolean().optional(),
    sessionInstanceId: idSchema.optional(),
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
  "data.unlock": z.object({
    token: idSchema,
    password: z.string().min(1).max(1024),
  }),
  "data.cancel": z.object({ token: idSchema }),
  "data.apply": z.object({
    token: idSchema,
    conflict: z.enum(["skip", "overwrite"]),
  }),
  "backup.list": z.undefined(),
  "backup.preview": z.object({
    name: z.string().regex(/^\d{4}-\d{2}-\d{2}\.json$/),
  }),
  "clipboard.read": z.undefined(),
  "clipboard.terminal": idObject,
  "clipboard.write": z.object({ text: z.string().max(4 * 1024 * 1024) }),
  "external.open": z.object({
    target: z.enum(["github", "issues", "releases", "email"]),
  }),
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
  if (data.omittedTemplates)
    warnings.push(
      `여러 탭을 묶은 기존 템플릿 ${data.omittedTemplates}개를 제외했습니다.`,
    );
  const duplicates = data.document.hosts.filter((h) =>
    current.hosts.some(
      (c) => c.id === h.id || hostIdentity(c) === hostIdentity(h),
    ),
  ).length;
  if (data.document.hosts.some((h) => h.startPath))
    warnings.push("가져온 시작 경로를 서버에서 확인해 주세요.");
  const availableFonts = new Set([...bundledFonts, ...fonts]);
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
  for (const workspace of [
    ...data.document.workspaces,
    ...data.document.workspaceTemplates.flatMap((t) => t.workspaces),
  ])
    for (const pane of panes(workspace.root)) {
      if (!pane.local) continue;
      pane.local.needsReview = true;
      warnings.push(
        `${workspace.name}: 로컬 폴더·셸·시작 프로파일을 확인한 뒤 실행할 수 있습니다.`,
      );
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
    case "share.state":
      return sharing.snapshot();
    case "share.dismissError":
      return sharing.dismissError(i.errorId);
    case "share.unlock":
      return sharing.unlock();
    case "share.reset":
      return sharing.resetIdentity();
    case "share.configure":
      return sharing.configure(i);
    case "share.invite":
      return sharing.invite();
    case "share.join":
      return sharing.join(i.key, i.alias);
    case "share.pair":
      return sharing.approvePair(i.id, i.accept, i.alias);
    case "share.peer":
      return sharing.updatePeer(i.id, i);
    case "share.send":
      return sharing.send(i);
    case "share.approve":
      return sharing.approve(i.id, i.accept);
    case "share.cancel":
      return sharing.cancel(i.id);
    case "share.message":
      return sharing.store.message(i.id);
    case "share.openAttachment": {
      const attachment = sharing.store.message(i.id).attachment;
      if (!attachment) throw new Error("첨부 파일이 없습니다.");
      shareFileName(path.basename(attachment.path));
      const file = await fs.lstat(attachment.path).catch(() => null);
      if (!file?.isFile() || file.isSymbolicLink())
        throw new Error(
          "저장한 파일을 찾을 수 없습니다. 이동하거나 삭제했는지 확인하세요.",
        );
      const error = await shell.openPath(attachment.path);
      if (error) throw new Error("기본 앱으로 파일을 열 수 없습니다.");
      return;
    }
    case "share.deleteMessage":
      sharing.store.removeMessage(i.id);
      emit({ kind: "share-changed" });
      return;
    case "share.folder": {
      const result = await dialog.showOpenDialog(caller, {
        title: "쪽지 첨부 파일 저장 폴더",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    }
    case "share.file": {
      const result = await dialog.showOpenDialog(caller, {
        title: "쪽지에 첨부할 파일",
        properties: ["openFile"],
        filters: [
          {
            name: "허용된 문서·이미지·압축파일",
            extensions: [...shareExtensions],
          },
        ],
      });
      return result.canceled ? null : result.filePaths[0];
    }
    case "control.reply":
      controlInspector.reply(caller.id, i);
      return;
    case "terminal.folder": {
      const result = await dialog.showOpenDialog(caller, {
        title: "프로젝트 폴더 선택",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    }
    case "terminal.preview": {
      const document = store.read();
      return previewEnvironment(i.local, document.settings.terminal);
    }
    case "terminal.create":
      return addLocalTerminal(caller);
    case "window.keyboardContext":
      keyboardContexts.set(caller.id, i);
      caller.webContents.setIgnoreMenuShortcuts(i === "recording");
      return;
    case "window.create":
      return (await createWindow(true)).id;
    case "activity.list":
      return activity.list();
    case "activity.read":
      activity.read(i.id);
      return;
    case "activity.clear":
      activity.clear();
      return;
    case "activity.open":
      return openActivity(i.id);
    case "activity.focus":
      if (i.paneId) assertOwned(i.paneId, caller);
      focusedPanes.set(caller.id, i.paneId);
      if (i.paneId && isPaneViewed(i.paneId)) activity.readPane(i.paneId);
      return;
    case "activity.settings":
      await platform.desktop.openNotificationSettings(shell);
      return;
    case "activity.test": {
      if (!desktopNotifications.isSupported()) return false;
      const banner = desktopNotifications.create({
        title: "Passport 알림 테스트",
        body: "Passport 데스크톱 테스트 알림입니다.",
        silent: !store.read().settings.notifications.sound,
      });
      trackBanner(banner);
      banner.once("close", () => banners.delete(banner));
      banner.once("failed", () => {
        banners.delete(banner);
        emit({
          kind: "notice",
          message:
            "알림 표시 실패: 운영체제 권한과 방해 금지 설정을 확인하세요.",
        });
      });
      banner.show();
      return true;
    }
    case "resume.reply":
      resume.reply(caller.id, i.token, i.screen);
      return;
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
      resume.configure(saved);
      if (doc.settings.sessionResume && !previous.settings.sessionResume)
        for (const [id, state] of states)
          if (state.status === "connected") {
            const launch = locals.sessions.get(id)?.launch;
            // Existing shell hooks keep their original authenticated generation.
            // Never inject shell commands into a running foreground application.
            const tracking =
              launch?.env.PASSPORT_RESUME === "1" ||
              !!sessions.sessions.get(id)?.filter;
            resume.begin(
              id,
              launch?.snapshot.sessionInstanceId ||
                state.generation ||
                randomUUID(),
              tracking,
            );
            const group = logs.groupFor(id);
            if (group) resume.logGroup(id, group);
            if (!tracking) resumeNotice(id, resumeReconnectMessage);
          }
      if (!doc.settings.sessionResume) {
        resumeMessages.clear();
        for (const local of locals.sessions.values())
          local.launch?.clearResume?.();
        for (const state of states.values())
          if (state.resumeMessage)
            emit({
              kind: "session",
              state: { ...state, resumeMessage: undefined },
            });
      }
      terminalControl.configure(doc.settings.terminal.cliAccess);
      activity.restrictAgents(doc.settings.notifications);
      if (
        doc.settings.autoLog !== previous.settings.autoLog ||
        doc.settings.terminal.autoLogLocal !==
          previous.settings.terminal.autoLogLocal
      ) {
        for (const [id, state] of states) {
          if (!shouldAutoLog(id)) logs.stop(id);
          else if (state.status === "connected") {
            try {
              startSessionLog(id);
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
      logs.retainConnections(allowed);
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
      let current = store.read();
      if (
        !current.workspaces
          .flatMap((w) => panes(w.root))
          .some((p) => p.id === i.id && p.hostId === i.hostId)
      )
        throw new Error("현재 작업 배치에 없는 터미널입니다.");
      assertOwned(i.id, caller);
      // Reserve the pane before waiting for a renderer checkpoint or SSH auth.
      if (connectionTickets.has(i.id)) return;
      if (
        i.onlyIfDisconnected &&
        ["connected", "connecting"].includes(states.get(i.id)?.status || "")
      )
        return;
      const pane = current.workspaces
        .flatMap((w) => panes(w.root))
        .find((p) => p.id === i.id)!;
      const ticket = randomUUID();
      connectionTickets.set(i.id, ticket);
      const check = () => {
        if (
          connectionTickets.get(i.id) !== ticket ||
          ownerOf(i.id) !== caller.id ||
          !store
            .read()
            .workspaces.flatMap((w) => panes(w.root))
            .some(
              (p) =>
                p.id === i.id && JSON.stringify(p) === JSON.stringify(pane),
            )
        )
          throw new Error("터미널 연결 요청이 취소되거나 변경되었습니다.");
      };
      try {
        await resume.checkpoint(i.id);
        check();
        closeSession(i.id, true, true);
        resumeMessages.delete(i.id);
        current = store.read();
        const generation = randomUUID();
        resume.begin(i.id, generation);
        logs.beginConnection(
          i.id,
          resume.get(i.id)?.logGroup,
          resume.get(i.id)?.fingerprint,
        );
        emit({
          kind: "session",
          state: { id: i.id, status: "connecting", generation },
        });
        if (pane.local) await resume.hydrate(i.id);
        check();
        const savedResume = resume.get(i.id);
        if (savedResume?.reason) resumeNotice(i.id, savedResume.reason);
        if (pane.local) {
          let launch: ReturnType<typeof prepareLaunch> | undefined;
          try {
            let local = pane.local;
            if (savedResume?.cwd) {
              try {
                if (!(await fs.stat(savedResume.cwd)).isDirectory())
                  throw new Error();
                local = { ...local, cwd: savedResume.cwd };
              } catch {
                resumeNotice(
                  i.id,
                  "이전 작업 폴더를 열 수 없어 기본 폴더로 연결했습니다.",
                );
                try {
                  if (
                    !(
                      await fs.stat(
                        local.cwd ||
                          current.settings.terminal.cwd ||
                          os.homedir(),
                      )
                    ).isDirectory()
                  )
                    throw new Error();
                } catch {
                  local = { ...local, cwd: os.homedir() };
                }
              }
            }
            check();
            const snapshot = previewEnvironment(
              local,
              current.settings.terminal,
            );
            snapshot.sessionInstanceId = generation;
            let agent = savedResume?.agent;
            if (agent) {
              const problem = await agentResumeProblem(agent);
              check();
              if (problem) agent = { ...agent, reason: problem };
            }
            if (agent?.running && !agentResumeCommand(agent))
              resumeNotice(
                i.id,
                agent.reason ||
                  (agent.agent === "codex"
                    ? "Codex 대화 ID를 받지 못해 셸만 복원했습니다. Codex의 훅 검토 화면 또는 /hooks에서 Passport 훅을 신뢰한 뒤 대화를 시작하세요."
                    : "Claude 대화 ID를 받지 못해 셸만 복원했습니다. Claude의 훅 설정과 실행 옵션을 확인하세요."),
              );
            localEnvironments.set(i.id, snapshot);
            const integration = selectedProfiles(
              current.settings.terminal,
              pane.local.profiles,
            ).some((p) => p.integration === "ai-notifications");
            const credentials = activity.register(
              i.id,
              snapshot.sessionInstanceId,
              {
                claude: integration && current.settings.notifications.claude,
                codex: integration && current.settings.notifications.codex,
              },
            );
            launch = prepareLaunch(
              local,
              current.settings.terminal,
              current.settings.notifications,
              path.join(app.getPath("userData"), "shell-sessions"),
              {
                ...credentials,
                ...terminalControl.register(i.id, snapshot.sessionInstanceId),
              },
              snapshot,
              {
                enabled: resume.enabled,
                agent,
                skipAgent: !!savedResume?.reason || !!agent,
                restoreCwd: !!savedResume?.cwd && local.cwd === savedResume.cwd,
              },
            );
            if (resume.enabled && snapshot.shell === "cmd")
              cwdParsers.set(
                i.id,
                new ResumeOutput(generation, (kind, value) => {
                  if (kind === "cwd") resume.cwd(i.id, value);
                }),
              );
            locals.open(i.id, pane.local, launch);
          } catch (error) {
            launch?.cleanup();
            activity.unregister(i.id);
            emit({
              kind: "session",
              state: {
                id: i.id,
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              },
            });
            throw error;
          }
          return;
        }
        const { host, secret } = secretFor(i.hostId, i.secret);
        const startup = host.startupSnippetId
          ? current.snippets.find((s) => s.id === host.startupSnippetId)
              ?.content
          : undefined;
        if (startup && /\{\{/.test(startup))
          throw new Error("시작 스니펫은 입력 변수가 없는 명령을 선택하세요.");
        activity.register(i.id, generation);
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
      } catch (error) {
        if (connectionTickets.get(i.id) === ticket) {
          closeSession(i.id, true, true);
          emit({
            kind: "session",
            state: {
              id: i.id,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        throw error;
      } finally {
        if (connectionTickets.get(i.id) === ticket)
          connectionTickets.delete(i.id);
      }
    }
    case "session.close": {
      const ticket = randomUUID();
      connectionTickets.set(i.id, ticket);
      resume.stop(i.id, false);
      await resume.checkpoint(i.id);
      if (connectionTickets.get(i.id) === ticket) closeSession(i.id);
      return;
    }
    case "session.input":
      if (
        i.sessionInstanceId &&
        (!locals.sessions.get(i.id)?.alive ||
          moves.has(workspaceFor(i.id)?.id || "") ||
          locals.sessions.get(i.id)?.launch?.snapshot.sessionInstanceId !==
            i.sessionInstanceId)
      )
        throw new Error("파일 드롭 대상 터미널 연결이 변경되었습니다.");
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
    case "terminal.drop": {
      assertOwned(i.id, caller);
      const local = locals.sessions.get(i.id);
      if (!local) {
        if (
          sessions.sessions.has(i.id) ||
          store
            .read()
            .workspaces.flatMap((w) => panes(w.root))
            .some((p) => p.id === i.id && !p.local)
        )
          throw new Error(sshFileDropMessage);
        throw new Error("로컬 터미널에 연결한 뒤 파일·폴더를 드롭하세요.");
      }
      const snapshot = local.launch?.snapshot;
      const check = () => {
        assertOwned(i.id, caller);
        if (
          !snapshot ||
          snapshot.sessionInstanceId !== i.sessionInstanceId ||
          moves.has(workspaceFor(i.id)?.id || "") ||
          !local.alive ||
          locals.sessions.get(i.id) !== local ||
          states.get(i.id)?.status !== "connected"
        )
          throw new Error("파일 드롭 대상 터미널 연결이 변경되었습니다.");
      };
      check();
      const text = await prepareTerminalDrop({
        paths: i.paths,
        platform: process.platform,
        shell: snapshot!.shell,
        check,
      });
      return { text, sessionInstanceId: snapshot!.sessionInstanceId };
    }
    case "clipboard.terminal": {
      assertOwned(i.id, caller);
      const local = locals.sessions.get(i.id);
      const remote = sessions.sessions.get(i.id);
      const check = () => {
        assertOwned(i.id, caller);
        if (
          states.get(i.id)?.status !== "connected" ||
          (local
            ? locals.sessions.get(i.id) !== local || !local.alive
            : !remote || sessions.sessions.get(i.id) !== remote)
        )
          throw new Error("붙여넣기 대상 터미널 연결이 변경되었습니다.");
      };
      return prepareTerminalClipboard({
        read: () => clipboard.read(),
        readNativeFiles: platform.clipboard.readNativeFiles,
        toPNG: (bytes) => {
          const image = nativeImage.createFromBuffer(bytes);
          const size = image.getSize();
          if (image.isEmpty() || size.width * size.height > 64_000_000)
            throw new Error(
              "이미지가 손상되었거나 6400만 픽셀을 초과했습니다.",
            );
          return image.toPNG();
        },
        userData: app.getPath("userData"),
        platform: process.platform,
        shell: local?.launch?.snapshot.shell,
        check,
      });
    }
    case "clipboard.write":
      await clipboard.writeText(i.text);
      return;
    case "external.open":
      await shell.openExternal(
        about.links[i.target as keyof typeof about.links],
      );
      return;
    case "terminal.link": {
      assertOwned(i.id, caller);
      const url = terminalLinkURL(i.url);
      const result = await dialog.showMessageBox(caller, {
        type: "question",
        title: "링크 열기",
        message: "기본 브라우저에서 이 링크를 여시겠습니까?",
        detail: url,
        buttons: ["취소", "브라우저에서 열기"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1 || caller.isDestroyed()) return;
      assertOwned(i.id, caller);
      await shell.openExternal(url);
      return;
    }
    case "updates.check":
      return updates.check();
    case "updates.open":
      await shell.openExternal(updates.target(i.target));
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
      for (const [token, pending] of encryptedImports)
        if (pending.owner === caller.id) encryptedImports.delete(token);
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
            version: 2,
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
            version: 2,
            document: { ...emptyDocument(), snippets: parsed.snippets },
            profiles: [],
          },
          [],
          "snippets",
        );
      }
      if (!i.password && isEncryptedPortable(text)) {
        const token = randomUUID();
        encryptedImports.set(token, { text, owner: caller.id });
        setTimeout(() => encryptedImports.delete(token), 5 * 60 * 1000).unref();
        return {
          token,
          name: path.basename(result.filePaths[0]),
          needsPassword: true,
        };
      }
      return preview(await decodePortable(text, i.password));
    }
    case "data.unlock": {
      const pending = encryptedImports.get(i.token);
      if (!pending || pending.owner !== caller.id)
        throw new Error(
          "선택한 파일이 만료되었습니다. 파일을 다시 선택해 주세요.",
        );
      const data = await decodePortable(pending.text, i.password);
      if (encryptedImports.get(i.token) !== pending)
        throw new Error(
          "선택한 파일이 만료되었습니다. 파일을 다시 선택해 주세요.",
        );
      encryptedImports.delete(i.token);
      return preview(data);
    }
    case "data.cancel": {
      const pending = encryptedImports.get(i.token);
      if (pending?.owner === caller.id) encryptedImports.delete(i.token);
      return;
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
    case "logs.groups":
      return logs.groups();
    case "logs.readGroup":
      return logs.readGroup(i.id, i.cursor, i.query);
    case "logs.deleteGroup":
      logs.deleteGroup(i.id);
      return;
    case "logs.record": {
      if (i.enabled) {
        if (states.get(i.id)?.status !== "connected")
          throw new Error("연결된 세션에서 기록을 시작하세요.");
        startSessionLog(i.id);
      } else logs.stop(i.id);
      return;
    }
    case "logs.read":
      return logs.read(i.id, i.offset, i.query, i.plain);
    case "logs.bookmark":
      logs.bookmark(i.id, i.offset, i.label);
      return;
    case "logs.delete":
      logs.delete(i.id);
      return;
    case "logs.export":
    case "logs.exportGroup": {
      const group = name === "logs.exportGroup";
      const row = group ? logs.group(i.id) : logs.get(i.id);
      const result = await dialog.showSaveDialog(caller, {
        title: "세션 로그 내보내기",
        defaultPath: `passport-${row.id}.log`,
      });
      if (result.canceled || !result.filePath) return false;
      if (group) await logs.exportGroup(i.id, result.filePath);
      else logs.export(i.id, result.filePath);
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
        title: `${appIdentity.name} 창 ${w.id}`,
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
      if (!e2eWindowMode) target.focus();
      return;
    }

    case "backup.list":
      return store.backups();
    case "backup.preview":
      return preview(store.readBackup(i.name));
  }
}
function addLocalTerminal(caller: BrowserWindow) {
  if (moves.size) throw new Error("창 이동이 완료된 후 다시 시도해 주세요.");
  const doc = store.read(),
    workspaceId = randomUUID(),
    paneId = randomUUID();
  const workspace = localWorkspace(doc, workspaceId, paneId);
  const saved = store.save({
    ...doc,
    workspaces: [...doc.workspaces, workspace],
  });
  owners.set(workspaceId, caller.id);
  publishDocument(saved);
  return { workspaceId, paneId };
}
async function createWindow(withLocalTerminal = false) {
  if (withLocalTerminal) {
    assertTerminalCapacity(store.read());
    if (moves.size) throw new Error("창 이동이 완료된 후 다시 시도해 주세요.");
  }
  const desktopContext = {
    identity: appIdentity,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    executable: process.execPath,
    packaged: app.isPackaged,
  };
  const win = new BrowserWindow({
    ...platform.desktop.windowOptions(desktopContext),
    ...testWindowOptions(e2eWindowMode),
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: appIdentity.name,
    backgroundColor: "#171b20",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !e2eWindowMode,
    },
  });
  platform.desktop.configureWindow(win, desktopContext, e2eWindowMode);
  if (developmentBuild)
    win.on("page-title-updated", (event) => event.preventDefault());
  if (e2eWindowMode) {
    e2eWindowAudit.created++;
    win.on("show", () => e2eWindowAudit.shown++);
    if (e2eWindowMode === "passive")
      win.once("ready-to-show", () => {
        if (!win.isDestroyed()) win.showInactive();
      });
  }
  windows.set(win.id, win);
  if (!window) window = win;
  for (const w of store.read().workspaces)
    if (!owners.has(w.id)) owners.set(w.id, win.id);
  win.webContents.on("before-input-event", (_event, input) => {
    const event = {
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
      isComposing: input.isComposing,
    };
    win.webContents.setIgnoreMenuShortcuts(
      ignoreShortcutMenu(
        keyboardContexts.get(win.id) || "standard",
        event,
        (documentCache ??= store.read()).settings.shortcuts,
        platform.id,
      ),
    );
  });
  win.on("closed", () => keyboardContexts.delete(win.id));
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
    // Closing a window must release its live resources even if persisted
    // settings have become unreadable. Ownership uses the last accepted layout.
    for (const w of documentCache?.workspaces ?? [])
      if (owners.get(w.id) === win.id)
        for (const p of panes(w.root))
          closeSession(p.id, resume.get(p.id)?.automatic ?? true);
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
    if (details.isMainFrame && !details.isSameDocument) {
      keyboardContexts.delete(win.id);
      win.webContents.setIgnoreMenuShortcuts(false);
      releaseConnections();
    }
  });
  let closing = false;
  let checkpointed = false;
  const checkpointWindow = async () => {
    const ids = [...states.keys()].filter((id) => ownerOf(id) === win.id);
    for (const id of ids) resume.stop(id, resume.get(id)?.automatic ?? true);
    await Promise.all(ids.map((id) => resume.checkpoint(id)));
    checkpointed = true;
    if (!win.isDestroyed()) win.close();
  };
  win.on("close", (event) => {
    if (closing) {
      if (resume.enabled && !checkpointed) {
        event.preventDefault();
        void checkpointWindow();
      }
      return;
    }
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
            if (resume.enabled)
              void checkpointWindow().then(() => {
                if (quitting) app.quit();
              });
            else if (quitting) app.quit();
            else win?.close();
          } else {
            quitting = false;
          }
        });
    }
  });
  win.on("closed", () => {
    focusedPanes.delete(win.id);
    initialTerminals.delete(win.id);
    for (const [token, pending] of encryptedImports)
      if (pending.owner === win.id) encryptedImports.delete(token);
    releaseConnections();
    windows.delete(win.id);
    window = windows.values().next().value;
    for (const [workspace, id] of owners)
      if (id === win.id) {
        if (window) owners.set(workspace, window.id);
        else owners.delete(workspace);
      }
    if (windows.size && documentCache) publishDocument(documentCache);
  });
  const dev =
    !app.isPackaged && process.env.PASSPORT_DEV_URL === "http://127.0.0.1:5173";
  let createdTerminal: { workspaceId: string; paneId: string } | undefined;
  try {
    if (withLocalTerminal) {
      createdTerminal = addLocalTerminal(win);
      initialTerminals.set(win.id, createdTerminal);
    }
    await win.loadURL(
      dev ? "http://127.0.0.1:5173" : "passport://app/index.html",
    );
  } catch (error) {
    if (
      !quitting &&
      createdTerminal &&
      owners.get(createdTerminal.workspaceId) === win.id
    ) {
      closeSession(createdTerminal.paneId);
      const doc = store.read();
      const saved = store.save({
        ...doc,
        workspaces: doc.workspaces.filter(
          (workspace) => workspace.id !== createdTerminal!.workspaceId,
        ),
      });
      owners.delete(createdTerminal.workspaceId);
      publishDocument(saved);
    }
    // Closing a window during its initial navigation rejects loadURL as well.
    if (!quitting && !win.isDestroyed()) {
      win.destroy();
      throw error;
    }
  }
  if (withLocalTerminal && !win.isDestroyed())
    presentWindow(win, e2eWindowMode);
  return win;
}
void app
  .whenReady()
  .then(async () => {
    if (!ownsDataDirectory) return;
    updates = new UpdateChecker({
      version: appVersion,
      platform: process.platform,
      arch: process.arch,
      fetch: (url, init) => net.fetch(url, init),
      emit: (state) => emit({ kind: "update", state }),
    });
    fonts = await getFonts({ disableQuoting: true }).catch(() => []);
    store = new Store(app.getPath("userData"), safeStorage);
    sharing = new ShareService(
      new ShareStore(
        app.getPath("userData"),
        safeStorage,
        app.getPath("downloads"),
      ),
      {
        protect: platform.protectDownload,
        completed: (message) => emit({ kind: "notice", message }),
        changed: () => {
          terminalControl?.configure(store.read().settings.terminal.cliAccess);
          emit({ kind: "share-changed" });
        },
        attention: () => {
          // Hidden E2E never creates native notification surfaces.
          if (
            e2eWindowMode ||
            !desktopNotifications.isSupported() ||
            store.read().settings.notifications.desktop === "off"
          )
            return;
          const banner = desktopNotifications.create({
            title: "Passport 쪽지 승인 요청",
            body: "쪽지에서 상대와 요청 내용을 확인해 주세요.",
            silent: !store.read().settings.notifications.sound,
          });
          trackBanner(banner);
          banner.once("click", () => {
            const target = window;
            if (target) {
              presentWindow(target, e2eWindowMode);
              target.webContents.send("passport:event", {
                kind: "share-open",
              } satisfies AppEvent);
            }
          });
          banner.once("close", () => banners.delete(banner));
          banner.once("failed", () => banners.delete(banner));
          banner.show();
        },
      },
    );
    if (sharing.store.settings().enabled)
      await sharing.configure(sharing.store.settings()).catch(() => {});
    logs = new SessionLogs(store, (message) =>
      emit({ kind: "notice", message }),
    );
    const loaderRoot = path.join(app.getPath("userData"), "shell-sessions");
    for (const entry of await fs
      .readdir(loaderRoot, { withFileTypes: true })
      .catch(() => []))
      if (
        entry.isDirectory() &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(entry.name)
      )
        await fs
          .rm(path.join(loaderRoot, entry.name), {
            recursive: true,
            force: true,
          })
          .catch(() => {});
    locals = new LocalSessions(emit);
    resume = new SessionResume(store, {
      owner: ownerOf,
      send: (owner, event) => {
        const w = windows.get(owner);
        if (w && !w.isDestroyed()) w.webContents.send("passport:event", event);
      },
      notice: resumeNotice,
    });
    activity = new ActivityService(store.db, {
      agentChanged: (id, generation) => {
        const state = states.get(id);
        if (state?.status === "connected" && state.generation === generation)
          emit({ kind: "session", state: { ...state } });
      },
      resume: (id, event) => {
        resume.agentEvent(id, event);
        if (event.event === "run-start")
          locals.sessions.get(id)?.launch?.clearResume?.();
      },
      workspace: (paneId) => workspaceFor(paneId)?.id,
      changed: (items) => {
        banners.sync(items);
        emit({ kind: "activity", items });
      },
      notify: desktopActivity,
      viewed: isPaneViewed,
      includeResponse: () =>
        store.read().settings.notifications.includeResponse,
      ready: (id, generation, result) => locals.ready(id, generation, result),
      error: (message) => emit({ kind: "notice", message }),
    });
    await activity.start();
    terminalControl = new TerminalControl({
      endpoint: platform.createControlEndpoint(),
      panels: controlPanels,
      tabMatches: (name) =>
        (documentCache ??= store.read()).workspaces.filter(
          (w) => w.name === name,
        ).length,
      inspect: controlInspector.inspect,
      write: (id, data) => locals.input(id, data),
      share: {
        enabled: () => sharing.enabled,
        execute: (input, authorize) => sharing.control(input, authorize),
      },
    });
    await terminalControl.start();
    terminalControl.configure(store.read().settings.terminal.cliAccess);
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
    sessions = new Sessions(store, confirm, emit, detectedOS, {
      enabled: () => resume.enabled,
      begin: (id) => resume.begin(id, randomUUID()),
      previousCwd: (id, host) =>
        resume.sshCwd(id, store.fingerprint(host.address, host.port)),
      hydrate: async (id, host) => {
        resume.sshCwd(id, store.fingerprint(host.address, host.port));
        await resume.hydrate(id);
      },
      cwd: (id, cwd) => resume.cwd(id, cwd),
      notice: resumeNotice,
    });
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
          label: appIdentity.name,
          submenu: [
            { label: `${appIdentity.name} 정보`, role: "about" },
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
                process.platform === "darwin" ? "Command+C" : "Control+C",
            },
            {
              label: "붙여넣기",
              role: "paste",
              registerAccelerator: false,
              accelerator:
                process.platform === "darwin" ? "Command+V" : "Control+V",
            },
            { label: "전체 선택", role: "selectAll" },
          ],
        },
        {
          label: "보기",
          submenu: [
            { label: "전체 화면", role: "togglefullscreen" },
            ...(!app.isPackaged
              ? [
                  {
                    label: "개발자 도구",
                    role: "toggleDevTools" as const,
                    accelerator: "CommandOrControl+Alt+Shift+I",
                  },
                ]
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
    if (quitting) return;
    updates.start(
      app.isPackaged &&
        !developmentBuild &&
        process.env.PASSPORT_DISABLE_UPDATE_CHECK !== "1",
    );
    app.on("activate", () => {
      if (!window) void createWindow();
    });
    app.on("second-instance", () => {
      const target = BrowserWindow.getFocusedWindow() ?? window;
      if (target) {
        presentWindow(target, e2eWindowMode);
      } else void createWindow();
    });
  })
  .catch((error) => {
    if (quitting) return;
    if (e2eWindowMode) console.error("Passport 시작 실패", error);
    else
      dialog.showErrorBox(
        "Passport 시작 실패",
        error instanceof Error ? error.message : "앱을 시작할 수 없습니다.",
      );
    app.quit();
  });
app.on("window-all-closed", () => {
  if (platform.desktop.quitOnLastWindow) app.quit();
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
    terminalControl?.configure("off");
    updates?.dispose();
    tunnels?.closeAll();
    sessions?.closeAll();
    transfers?.cancelAll();
    files?.closeAll();
    await locals?.shutdown();
    banners.close();
    await activity?.close();
    await terminalControl?.close();
    await sharing?.close();
    resume?.close();
    store?.close();
    shutdownComplete = true;
    app.quit();
  })();
});
