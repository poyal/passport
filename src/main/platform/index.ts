import type { PlatformServices } from "./contracts";
import { createDarwinTerminal } from "./darwin/terminal";
import { createWindowsTerminal } from "./win32/terminal";
import { createDarwinClipboard } from "./darwin/clipboard";
import { createWindowsClipboard } from "./win32/clipboard";
import { darwinDesktop } from "./darwin/desktop";
import { windowsDesktop } from "./win32/desktop";
import { createDarwinActivityEndpoint } from "./darwin/activity-endpoint";
import { createWindowsActivityEndpoint } from "./win32/activity-endpoint";

// Factories only capture dependencies. Reading shells, opening OS services and
// creating sockets must wait for an explicit call by the owning service.
const services: Record<string, PlatformServices> = {
  darwin: {
    id: "darwin",
    terminal: createDarwinTerminal(),
    clipboard: createDarwinClipboard(),
    desktop: darwinDesktop,
    createActivityEndpoint: createDarwinActivityEndpoint,
  },
  win32: {
    id: "win32",
    terminal: createWindowsTerminal(),
    clipboard: createWindowsClipboard(),
    desktop: windowsDesktop,
    createActivityEndpoint: createWindowsActivityEndpoint,
  },
};
export function selectPlatform(id: string): PlatformServices {
  if (!Object.hasOwn(services, id))
    throw new Error(`지원하지 않는 운영체제입니다: ${id}`);
  return services[id];
}
export const platform = selectPlatform(process.platform);
// Existing codec and named-pasteboard test entry points remain compatible.
export {
  readMacClipboardFiles,
  macFileClipboardScript,
} from "./darwin/clipboard";
export { decodeDropFiles } from "./win32/clipboard";
