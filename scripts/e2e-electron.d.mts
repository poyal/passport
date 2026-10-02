import type { _electron, Page } from "@playwright/test";
export const electron: Pick<typeof _electron, "launch">;
export function assertBackgroundCapable(executable?: string): Promise<void>;
export function focusTerminalPage(page: Page): Promise<void>;
export function electronLaunchEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
