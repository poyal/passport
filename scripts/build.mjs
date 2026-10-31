import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, copyFile } from "node:fs/promises";
import { patchPtyInput } from "./patch-pty-input.mjs";
import "./notices.mjs";
import "./patch-ssh2.mjs";
import "./build-helper.mjs";
await patchPtyInput("node_modules/node-pty");
await mkdir("build", { recursive: true });
await copyFile("assets/app-icon.png", "build/icon.png");
if (process.platform === "win32") {
  const { buildWindowsIcon } = await import("./build-icons.mjs");
  await buildWindowsIcon();
}
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: [
    "electron",
    "better-sqlite3",
    "ssh2",
    "basic-ftp",
    "font-list",
    "node-pty",
  ],
  sourcemap: true,
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await viteBuild();
