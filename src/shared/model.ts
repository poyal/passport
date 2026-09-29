import { z } from "zod";

export const idSchema = z.string().uuid();
const short = z.string().max(256);
export const appearanceFields = {
  theme: short,
  font: short,
  fontSize: z.number().int().min(8).max(36),
  lineHeight: z.number().min(1).max(2),
  letterSpacing: z.number().min(-1).max(5),
  fontWeight: z.enum(["normal", "bold"]),
  cursorStyle: z.enum(["block", "underline", "bar"]),
  cursorBlink: z.boolean(),
  highlight: z.enum(["none", "log", "line", "address"]),
  highlightAddresses: z.boolean(),
};
export const appearanceOverridesSchema = z.object(appearanceFields).partial();
export const appearanceSchema = z.object({
  theme: short.default("mocha"),
  font: short.default("JetBrains Mono"),
  fontSize: appearanceFields.fontSize.default(14),
  lineHeight: appearanceFields.lineHeight.default(1.2),
  letterSpacing: appearanceFields.letterSpacing.default(0),
  fontWeight: appearanceFields.fontWeight.default("normal"),
  cursorStyle: appearanceFields.cursorStyle.default("block"),
  cursorBlink: z.boolean().default(false),
  highlight: appearanceFields.highlight.default("none"),
  highlightAddresses: z.boolean().default(false),
});
export const tunnelSchema = z.object({
  id: idSchema,
  name: short.min(1),
  hostId: idSchema,
  kind: z.enum(["local", "remote", "dynamic"]),
  bindAddress: short.min(1).default("127.0.0.1"),
  bindPort: z.number().int().min(1).max(65535),
  targetAddress: short.default("127.0.0.1"),
  targetPort: z.number().int().min(1).max(65535).default(80),
});
export type TunnelRule = z.infer<typeof tunnelSchema>;
export type TunnelState = {
  id: string;
  status: "starting" | "running" | "stopped" | "error";
  message?: string;
};
export const customThemeSchema = z.object({
  id: idSchema,
  name: short.min(1),
  colors: z.record(
    z.enum([
      "background",
      "foreground",
      "cursor",
      "cursorAccent",
      "selectionBackground",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ]),
    z.string().regex(/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/),
  ),
});
export type CustomTheme = z.infer<typeof customThemeSchema>;
export const localShellSchema = z.object({
  shell: z
    .enum(["default", "zsh", "bash", "powershell", "cmd"])
    .default("default"),
  cwd: z.string().max(4096).default(""),
});
export type LocalShell = z.infer<typeof localShellSchema>;
export type Appearance = z.infer<typeof appearanceSchema>;
export const hostSchema = z.object({
  id: idSchema,
  name: short.min(1),
  address: short
    .min(1)
    .refine(
      (v) => !/[\s\0/]/.test(v),
      "주소에는 공백이나 경로를 넣을 수 없습니다.",
    ),
  port: z.number().int().min(1).max(65535).default(22),
  username: short
    .min(1)
    .refine(
      (v) => !/[\r\n\0]/.test(v),
      "사용자 이름에 제어 문자를 넣을 수 없습니다.",
    ),
  protocol: z.enum(["ssh", "sftp", "ftp", "ftps"]).default("ssh"),
  groupId: idSchema.nullable().default(null),
  tags: z.array(short).max(100).default([]),
  favorite: z.boolean().default(false),
  icon: z.enum(["server", "linux", "apple", "windows"]).default("server"),
  authId: idSchema.nullable().default(null),
  startPath: z
    .string()
    .max(4096)
    .refine((v) => !/[\r\n\0]/.test(v), "경로에 제어 문자를 넣을 수 없습니다.")
    .default(""),
  sftpPort: z.number().int().min(1).max(65535).optional(),
  sftpUsername: short.refine((v) => !/[\r\n\0]/.test(v)).optional(),
  sftpAuthId: idSchema.nullable().optional(),
  autoReconnect: z.boolean().default(false),
  lastConnected: z.number().default(0),
  appearance: appearanceOverridesSchema.default({}),
  inherit: z.array(z.enum(["port", "username", "authId"])).default([]),
  backspace: z.enum(["DEL", "BS"]).default("DEL"),
  environment: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128),
      z
        .string()
        .max(8192)
        .refine((v) => !v.includes("\0")),
    )
    .default({}),
  startupSnippetId: idSchema.nullable().default(null),
});
export type Host = z.infer<typeof hostSchema>;
export const groupSchema = z.object({
  id: idSchema,
  name: short.min(1),
  parentId: idSchema.nullable(),
  defaults: z
    .object({
      port: z.number().int().min(1).max(65535).optional(),
      username: short.min(1).optional(),
      authId: idSchema.nullable().optional(),
      appearance: appearanceOverridesSchema.optional(),
    })
    .default({}),
});
export type Group = z.infer<typeof groupSchema>;
export const snippetSchema = z.object({
  id: idSchema,
  name: short.min(1),
  content: z.string().max(65536),
  description: z.string().max(2048).default(""),
  group: short.default(""),
});
export type Snippet = z.infer<typeof snippetSchema>;
export type Pane = {
  kind: "pane";
  id: string;
  hostId: string;
  startPath?: string;
  local?: LocalShell;
};
export type Split = {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  children: [Layout, Layout];
};
export type Layout = Pane | Split;
const paneSchema = z.object({
  kind: z.literal("pane"),
  id: idSchema,
  hostId: idSchema,
  startPath: z.string().max(4096).optional(),
  local: localShellSchema.optional(),
});
export const layoutSchema: z.ZodType<Layout> = z.lazy(() =>
  z.union([
    paneSchema,
    z.object({
      kind: z.literal("split"),
      id: idSchema,
      direction: z.enum(["horizontal", "vertical"]),
      ratio: z.number().min(0.05).max(0.95),
      children: z.tuple([layoutSchema, layoutSchema]),
    }),
  ]),
);
export const workspaceSchema = z.object({
  id: idSchema,
  name: short.min(1),
  root: layoutSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const settingsSchema = z.object({
  appearance: appearanceSchema.default(() => appearanceSchema.parse({})),
  colorMode: z.enum(["system", "dark", "light"]).default("system"),
  customThemes: z.array(customThemeSchema).max(100).default([]),
  shortcuts: z
    .record(
      z.enum(["copy", "paste", "search", "nextPane", "previousPane", "newTab"]),
      z.string().max(80),
    )
    .default({
      copy: "Platform+C",
      paste: "Platform+V",
      search: "Mod+Shift+F",
      nextPane: "Alt+ArrowRight",
      previousPane: "Alt+ArrowLeft",
      newTab: "Mod+Shift+T",
    }),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
  logLimitMiB: z.number().int().min(10).max(1024).default(1024),
});
export const documentSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().default(0),
    tunnels: z.array(tunnelSchema).max(100).default([]),
    hosts: z.array(hostSchema).max(5000),
    groups: z.array(groupSchema).max(1000),
    snippets: z.array(snippetSchema).max(5000),
    workspaces: z.array(workspaceSchema).max(32),
    settings: settingsSchema,
  })
  .superRefine((d, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const list of [d.hosts, d.groups, d.snippets, d.workspaces])
      if (new Set(list.map((x) => x.id)).size !== list.length)
        fail("중복 ID가 있습니다.");
    const groupIds = new Set(d.groups.map((x) => x.id));
    const hostIds = new Set(d.hosts.map((x) => x.id));
    for (const h of d.hosts)
      if (h.groupId && !groupIds.has(h.groupId))
        fail("호스트의 그룹을 찾을 수 없습니다.");
    for (const group of d.groups) {
      const seen = new Set([group.id]);
      let parent = group.parentId;
      while (parent) {
        if (seen.has(parent)) {
          fail("그룹이 순환합니다.");
          break;
        }
        seen.add(parent);
        const g = d.groups.find((x) => x.id === parent);
        if (!g) {
          fail("상위 그룹을 찾을 수 없습니다.");
          break;
        }
        parent = g.parentId;
      }
    }
    for (const t of d.tunnels)
      if (!hostIds.has(t.hostId)) fail("터널의 호스트를 찾을 수 없습니다.");
    if (new Set(d.tunnels.map((t) => t.id)).size !== d.tunnels.length)
      fail("터널 ID가 중복됩니다.");
    if (
      new Set(d.settings.customThemes.map((t) => t.id)).size !==
      d.settings.customThemes.length
    )
      fail("테마 ID가 중복됩니다.");
    const ids = new Set<string>();
    let total = 0;
    const walk = (n: Layout, depth = 0): number => {
      if (depth > 16) {
        fail("분할 깊이를 초과했습니다.");
        return 0;
      }
      if (ids.has(n.id)) fail("분할 ID가 중복됩니다.");
      ids.add(n.id);
      if (n.kind === "pane") {
        if (!n.local && !hostIds.has(n.hostId))
          fail("배치의 호스트를 찾을 수 없습니다.");
        return 1;
      }
      return n.children.reduce((a, c) => a + walk(c, depth + 1), 0);
    };
    for (const w of d.workspaces) {
      const count = walk(w.root);
      if (count > 16) fail("작업 탭의 최대 분할 수는 16개입니다.");
      total += count;
    }
    if (total > 32) fail("최대 터미널 수는 32개입니다.");
  });
export type PassportDocument = z.infer<typeof documentSchema>;
export const emptyDocument = (): PassportDocument =>
  documentSchema.parse({
    version: 1,
    hosts: [],
    groups: [],
    snippets: [],
    workspaces: [],
    settings: {},
  });
export const secretSchema = z.object({
  type: z.enum(["password", "key"]),
  password: z.string().max(65536).default(""),
  privateKey: z.string().max(1048576).default(""),
  passphrase: z.string().max(65536).default(""),
});
export type Secret = z.infer<typeof secretSchema>;
export type AuthProfile = {
  id: string;
  name: string;
  type: "password" | "key";
  hasSecret?: boolean;
};
export type Bootstrap = {
  document: PassportDocument;
  profiles: AuthProfile[];
  platform: string;
  home: string;
  fonts: string[];
  windowId: number;
  workspaceOwners: Record<string, number>;
  sessionStates: SessionState[];
  tunnelStates: TunnelState[];
  shells: { id: LocalShell["shell"]; name: string }[];
};
export type SessionState = {
  id: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  message?: string;
};
export type FileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "link";
  size: number;
  modified: number;
  mode?: number;
};
export type Endpoint = {
  id: string;
  hostId: string | null;
  protocol: "local" | "sftp" | "ftp" | "ftps";
  label: string;
  initialPath: string;
};
export type TransferJob = {
  id: string;
  source: string;
  destination: string;
  paths: string[];
  target: string;
  conflict: "skip" | "overwrite" | "rename";
  state: "queued" | "running" | "completed" | "cancelled" | "error";
  bytes: number;
  total: number;
  files: number;
  skipped: number;
  speed: number;
  error?: string;
  cleanup?: string;
};
export type AppEvent =
  | { kind: "session"; state: SessionState }
  | { kind: "output"; id: string; data: string; bytes: number }
  | { kind: "transfer"; job: TransferJob }
  | {
      kind: "document";
      profiles: AuthProfile[];
      document: PassportDocument;
      workspaceOwners: Record<string, number>;
    }
  | { kind: "hydrate"; snapshots: TerminalSnapshot[]; workspaceId: string }
  | {
      kind: "window-transfer";
      token: string;
      workspaceId: string;
      target: number;
    }
  | { kind: "tunnel"; state: TunnelState };
export type TerminalSnapshot = {
  id: string;
  data: string;
  cols: number;
  rows: number;
  appearance?: Partial<Appearance>;
};
export type LogFile = {
  id: string;
  name: string;
  started: number;
  bytes: number;
  recording: boolean;
  sessionId?: string;
  bookmarks: { offset: number; label: string }[];
};
export type CommandSuggestion = {
  text: string;
  source: "snippet" | "history" | "path";
};
export type ImportPreview = {
  token: string;
  document: PassportDocument;
  profiles: AuthProfile[];
  duplicates: number;
  warnings: string[];
  kind: "passport" | "ssh" | "snippets";
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Calls {
  bootstrap: { input: undefined; output: Bootstrap };
  save: { input: PassportDocument; output: PassportDocument };
  "auth.save": {
    input: { id: string; name: string; secret: Secret };
    output: AuthProfile[];
  };
  "auth.delete": { input: { id: string }; output: AuthProfile[] };
  "key.pick": { input: undefined; output: string | null };
  "session.connect": {
    input: { id: string; hostId: string; secret?: Secret };
    output: void;
  };
  "session.execute": {
    input: { ids: string[]; command: string };
    output: void;
  };
  "session.broadcast": {
    input: { source: string; ids: string[]; data: string };
    output: void;
  };
  "command.suggest": {
    input: { query: string; endpointId?: string; path?: string };
    output: CommandSuggestion[];
  };
  "local.shells": { input: undefined; output: Bootstrap["shells"] };
  "tunnel.start": {
    input: { id: string; secret?: Secret };
    output: TunnelState;
  };
  "tunnel.stop": { input: { id: string }; output: void };
  "logs.list": { input: undefined; output: LogFile[] };
  "logs.record": { input: { id: string; enabled: boolean }; output: void };
  "logs.read": {
    input: { id: string; query?: string; offset?: number };
    output: { text: string; offset: number; next: number; matches: number[] };
  };
  "logs.bookmark": {
    input: { id: string; offset: number; label: string };
    output: void;
  };
  "logs.export": { input: { id: string }; output: boolean };
  "logs.delete": { input: { id: string }; output: void };
  "theme.import": { input: undefined; output: CustomTheme | null };
  "theme.export": { input: { id: string }; output: boolean };
  "window.move": {
    input: { workspaceId: string; target?: number };
    output: void;
  };
  "window.list": { input: undefined; output: { id: number; title: string }[] };
  "window.snapshot": {
    input: { token: string; snapshots: TerminalSnapshot[] };
    output: void;
  };
  "session.close": { input: { id: string }; output: void };
  "session.input": {
    input: { id: string; data: string; binary?: boolean };
    output: void;
  };
  "session.resize": {
    input: { id: string; cols: number; rows: number };
    output: void;
  };
  "session.ack": { input: { id: string; bytes: number }; output: void };
  "files.connections": { input: undefined; output: Endpoint[] };
  "files.connect": {
    input: { hostId: string | null; secret?: Secret; previousId?: string };
    output: Endpoint;
  };
  "files.close": { input: { id: string }; output: void };
  "files.list": {
    input: { id: string; path: string };
    output: { path: string; entries: FileEntry[] };
  };
  "files.action": {
    input: {
      id: string;
      action: "mkdir" | "touch" | "rename" | "delete" | "chmod";
      paths: string[];
      name?: string;
      mode?: number;
    };
    output: void;
  };
  "transfer.add": {
    input: {
      source: string;
      destination: string;
      paths: string[];
      target: string;
      conflict: TransferJob["conflict"];
    };
    output: TransferJob;
  };
  "transfer.cancel": { input: { id: string }; output: void };
  "transfer.retry": { input: { id: string }; output: TransferJob };
  "data.export": {
    input: { password?: string; kind?: "passport" | "snippets" };
    output: boolean;
  };
  "data.preview": {
    input: { password?: string; kind?: "passport" | "ssh" | "snippets" };
    output: ImportPreview | null;
  };
  "data.apply": {
    input: { token: string; conflict: "skip" | "overwrite" };
    output: Bootstrap;
  };
  "backup.list": { input: undefined; output: string[] };
  "backup.preview": { input: { name: string }; output: ImportPreview };
  "clipboard.read": { input: undefined; output: string };
  "clipboard.write": { input: { text: string }; output: void };
}
export type Call = keyof Calls;
export interface PassportAPI {
  call<K extends Call>(
    name: K,
    input: Calls[K]["input"],
  ): Promise<Calls[K]["output"]>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
