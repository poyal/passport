import type {
  App,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Shell,
} from "electron";
import type { IPty } from "node-pty";
import type path from "node:path";
import type {
  AppliedEnvironment,
  ShellInfo,
} from "../../shared/terminal-config";

export type PlatformId = "darwin" | "win32";
export type WindowMode = "hidden" | "passive" | undefined;
export type TerminalIdentity = Pick<
  AppliedEnvironment,
  "shell" | "sessionInstanceId"
>;
export interface PtyBehavior {
  observeOutput(data: string): void;
  input(data: string): string;
  resized(): void;
  terminate(pty: Pick<IPty, "kill">, alive: () => boolean): void;
  dispose(): void;
}
export interface TerminalPlatform {
  readonly id: PlatformId;
  readonly paths: typeof path.posix;
  readonly helperName: string;
  readonly useConptyDll: boolean;
  shells(resourceRoot: string): ShellInfo[];
  executableArchitecture(file: string): string;
  defaultArgs(executable: string): string[];
  posixPath(file: string): string;
  profileKey(name: string): string;
  configureEnvironment(
    env: NodeJS.ProcessEnv,
    snapshot: TerminalIdentity,
    resourceRoot: string,
  ): void;
  createPtyBehavior(snapshot?: TerminalIdentity): PtyBehavior;
}
export interface ClipboardEntry {
  types: readonly string[];
  getType(type: string): Promise<unknown>;
}
export interface ClipboardPlatform {
  readFiles(items: ClipboardEntry[]): Promise<string[] | undefined>;
  readNativeFiles?: (pasteboardName?: string) => Promise<string[]>;
}
export type DesktopContext = {
  appPath: string;
  resourcesPath: string;
  executable: string;
  packaged: boolean;
};
export interface DesktopPlatform {
  readonly quitOnLastWindow: boolean;
  initialize(
    app: Pick<App, "setActivationPolicy" | "setAppUserModelId">,
    mode: WindowMode,
  ): void;
  windowOptions(
    context: DesktopContext,
  ): Pick<
    BrowserWindowConstructorOptions,
    "icon" | "show" | "titleBarStyle" | "trafficLightPosition"
  >;
  configureWindow(
    win: Pick<BrowserWindow, "setAppDetails" | "once" | "show">,
    context: DesktopContext,
    mode: WindowMode,
  ): void;
  openNotificationSettings(shell: Pick<Shell, "openExternal">): Promise<void>;
}
export interface ActivityEndpoint {
  readonly address: string;
  listening(): void;
  dispose(): void;
}
export interface PlatformServices {
  readonly id: PlatformId;
  readonly terminal: TerminalPlatform;
  readonly clipboard: ClipboardPlatform;
  readonly desktop: DesktopPlatform;
  createActivityEndpoint(): ActivityEndpoint;
}
