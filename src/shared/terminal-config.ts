import { z } from "zod";

export const shellIdSchema = z.enum([
  "default",
  "zsh",
  "bash",
  "powershell",
  "windows-powershell",
  "pwsh",
  "cmd",
  "passport-bash",
]);
export type ShellId = z.infer<typeof shellIdSchema>;
const clean = z
  .string()
  .max(4096)
  .refine((v) => !/[\0\r\n]/.test(v), "줄바꿈과 NUL을 사용할 수 없습니다.");
const variable = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);
const reserved =
  /^(HOME|USERPROFILE|SHELL|COMSPEC|PATH|ZDOTDIR|BASH_ENV|ENV|PROMPT_COMMAND|PSMODULEPATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|LD_.*|DYLD_.*|MSYSTEM|PASSPORT_.*)$/i;
export const profileEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("alias"),
    name: variable,
    command: clean.min(1),
    args: z.array(clean).max(32).default([]),
    overwrite: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("env"),
    name: variable.refine(
      (n) => !reserved.test(n),
      "셸·런타임 필수 환경은 편집할 수 없습니다.",
    ),
    value: clean,
    overwrite: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("path"),
    value: clean.min(1),
    position: z.enum(["prepend", "append"]),
  }),
]);
export const startupProfileSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(100),
  revision: z.number().int().positive().default(1),
  origin: z.enum(["builtin", "user"]).default("user"),
  shells: z.array(shellIdSchema).min(1).max(8),
  platforms: z
    .array(z.enum(["win32", "darwin"]))
    .min(1)
    .max(2),
  entries: z.array(profileEntrySchema).max(100),
  integration: z.literal("ai-notifications").optional(),
});
export type StartupProfile = z.infer<typeof startupProfileSchema>;
export type ProfileEntry = z.infer<typeof profileEntrySchema>;
export const profileSelectionSchema = z.object({
  mode: z.enum(["inherit", "none", "custom"]),
  ids: z.array(z.string().max(128)).max(32).default([]),
});
export type ProfileSelection = z.infer<typeof profileSelectionSchema>;
export const terminalSettingsSchema = z.object({
  shell: shellIdSchema.default("default"),
  profileIds: z.array(z.string().max(128)).max(32).default([]),
  profiles: z.array(startupProfileSchema).max(100).default([]),
  autoLogLocal: z.boolean().default(false),
});
export type TerminalSettings = z.infer<typeof terminalSettingsSchema>;
export const notificationSettingsSchema = z.object({
  claude: z.boolean().default(false),
  codex: z.boolean().default(false),
  desktop: z.enum(["background", "unfocused", "off"]).default("background"),
  preview: z.boolean().default(false),
  sound: z.boolean().default(false),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const builtinProfiles: StartupProfile[] = [
  {
    id: "unix-shortcuts",
    name: "Unix 단축명령",
    revision: 1,
    origin: "builtin",
    shells: ["bash", "zsh", "passport-bash"],
    platforms: ["win32", "darwin"],
    entries: [
      {
        kind: "alias",
        name: "ll",
        command: "ls",
        args: ["-l"],
        overwrite: false,
      },
      {
        kind: "alias",
        name: "la",
        command: "ls",
        args: ["-A"],
        overwrite: false,
      },
    ],
  },
  {
    id: "ai-notifications",
    name: "AI 작업 알림",
    revision: 1,
    origin: "builtin",
    shells: [
      "bash",
      "zsh",
      "passport-bash",
      "cmd",
      "pwsh",
      "windows-powershell",
    ],
    platforms: ["win32", "darwin"],
    entries: [],
    integration: "ai-notifications",
  },
];
export function defaultTerminalSettings(
  platform: string,
  legacy = false,
): TerminalSettings {
  return {
    shell: platform === "win32" && !legacy ? "passport-bash" : "default",
    profileIds: platform === "win32" && !legacy ? ["unix-shortcuts"] : [],
    profiles: [],
    autoLogLocal: false,
  };
}
export function selectedProfiles(
  settings: TerminalSettings,
  project?: ProfileSelection,
  pane?: ProfileSelection,
): StartupProfile[] {
  const choice =
    pane && pane.mode !== "inherit"
      ? pane
      : project && project.mode !== "inherit"
        ? project
        : undefined;
  const ids =
    choice?.mode === "none"
      ? []
      : choice?.mode === "custom"
        ? choice.ids
        : settings.profileIds;
  if (new Set(ids).size !== ids.length)
    throw new Error("시작 프로파일이 중복되었습니다.");
  const all = [...builtinProfiles, ...settings.profiles];
  return ids.map((id) => {
    const profile = all.find((p) => p.id === id);
    if (!profile) throw new Error(`시작 프로파일을 찾을 수 없습니다: ${id}`);
    return profile;
  });
}
export type ShellInfo = {
  id: ShellId;
  name: string;
  path: string;
  architecture?: string;
  available: boolean;
  reason?: string;
};
export type AppliedEnvironment = {
  sessionInstanceId: string;
  shell: ShellId;
  executable: string;
  cwd: string;
  profiles: { id: string; name: string; revision: number }[];
  results: string[];
  status: "starting" | "ready" | "failed";
  agent?: "claude" | "codex";
};
