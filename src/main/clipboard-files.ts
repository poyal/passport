// Compatibility entry point; OS implementation selection belongs to platform/.
import { selectPlatform } from "./platform";
import type { ClipboardEntry } from "./platform/contracts";
export {
  clipboardBlob,
  validateFilePaths,
  decodeFileURLs,
  osClipboardFormat,
} from "./platform/shared/clipboard";
export type { ClipboardEntry } from "./platform/contracts";
export {
  readMacClipboardFiles,
  macFileClipboardScript,
  decodeDropFiles,
} from "./platform";
export function readClipboardFiles(items: ClipboardEntry[], platform: string) {
  return selectPlatform(platform).clipboard.readFiles(items);
}
