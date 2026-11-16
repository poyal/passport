import path from "node:path";
import type { UpdatePlatform } from "../contracts";
export const darwinUpdate: UpdatePlatform = {
  target: "darwin-arm64",
  helperName: "passport-updater",
  installRoot(executable) {
    const root = path.resolve(executable, "../../..");
    if (!root.endsWith(".app") || root.startsWith("/Volumes/"))
      throw new Error(
        "Passport를 응용 프로그램 폴더에 설치한 뒤 업데이트해 주세요.",
      );
    return root;
  },
};
