import path from "node:path";
import type { UpdatePlatform } from "../contracts";
export const windowsUpdate: UpdatePlatform = {
  target: "win32-x64",
  helperName: "passport-updater.exe",
  installRoot(executable) {
    return path.dirname(executable);
  },
};
